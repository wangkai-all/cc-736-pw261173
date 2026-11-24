import { SAMPLES, generateBatchDataset } from '../core/samples.js';
import { runSelfChecks } from '../core/selfCheck.js';
import { normalizeDataset } from '../core/pairs.js';
import { h, clear, fmtNumber, fmtPercent } from './dom.js';
import { renderRunChart, renderComparisonChart, renderConnectionGraph } from './charts.js';

const PAGE_SIZE = 50;

const REASON_META = {
  structure_barrier: ['拆分/合并阻断', 'serious'],
  same_day: ['同日成交', 'warning'],
  same_month: ['同月：设计行抵消', 'warning'],
  renovation_holding_period: ['持有期翻修，按规则排除', 'warning'],
  erroneous_entity_merge: ['错误实体合并', 'critical'],
  outlier: ['异常残差，按规则剔除', 'critical'],
};

const SAMPLE_ORDER = [
  ['handcheck', '小例核算'],
  ['disconnected', '断开月份'],
  ['sameDay', '同日成交'],
  ['badMerge', '错误合并'],
  ['renovationSplit', '翻修/拆分'],
];

function defaultConfig(slot) {
  return {
    baseMonth: '',
    weighting: 'equal',
    weightA: 0,
    weightB: 1,
    clusterSE: true,
    confidence: 0.95,
    renovationPolicy: slot === 'B' ? 'independent' : 'exclude',
    outlierPolicy: 'flag',
    outlierThreshold: 3.5,
    blockErroneousMerges: true,
  };
}

const state = {
  dataset: SAMPLES.renovationSplit,
  datasetName: SAMPLES.renovationSplit.meta.name,
  dataParseError: null,
  runs: {
    A: { config: defaultConfig('A'), result: null, loading: false, nonce: 0, timer: null, error: null },
    B: { config: defaultConfig('B'), result: null, loading: false, nonce: 0, timer: null, error: null },
  },
  selectedMonthBySlot: { A: null, B: null },
  traceSlot: 'A',
  pairSlot: 'A',
  pairFilter: 'impacted',
  pairSearch: '',
  pairPage: 1,
};

let worker = null;
try {
  worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (event) => {
    console.error('Worker error', event);
  };
} catch (error) {
  console.warn('Worker unavailable, using main-thread fallback', error);
}

function currentSeriesColor(slot) {
  const name = slot === 'A' ? '--series-a' : '--series-b';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || (slot === 'A' ? '#2a78d6' : '#eb6834');
}

function initTheme() {
  const saved = localStorage.getItem('repeat-sales-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
  updateThemeButton();
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    localStorage.setItem('repeat-sales-theme', document.documentElement.dataset.theme);
    updateThemeButton();
    renderAllResults();
  });
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('#theme-toggle').textContent = dark ? '切换浅色' : '切换深色';
}

function renderSampleButtons() {
  const host = document.querySelector('#sample-buttons');
  clear(host);
  for (const [key, label] of SAMPLE_ORDER) {
    host.append(
      h('button', {
        type: 'button',
        class: 'btn secondary small',
        title: SAMPLES[key].meta.description,
        onClick: () => loadDataset(SAMPLES[key], SAMPLES[key].meta.name),
      }, label),
    );
  }
}

function bindGlobalControls() {
  document.querySelector('#run-both').addEventListener('click', () => {
    scheduleRun('A', true);
    scheduleRun('B', true);
  });
  document.querySelector('#copy-a-to-b').addEventListener('click', () => {
    state.runs.B.config = { ...state.runs.A.config };
    renderConfigForm('B');
    scheduleRun('B', true);
  });
  document.querySelector('#generate-batch').addEventListener('click', (event) => {
    const count = Number(document.querySelector('#batch-size').value);
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = '生成中…';
    setTimeout(() => {
      try {
        const dataset = generateBatchDataset({ properties: count });
        loadDataset(dataset, dataset.meta.name);
      } finally {
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = '生成确定性批量样本';
      }
    }, 30);
  });
  document.querySelector('#file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      loadDataset(parsed, file.name);
    } catch (error) {
      state.dataParseError = `JSON 解析失败：${error.message}`;
      renderDataSummary();
    }
    event.target.value = '';
  });
  const paste = document.querySelector('#json-paste');
  document.querySelector('#toggle-paste').addEventListener('click', () => {
    paste.hidden = !paste.hidden;
    document.querySelector('#load-paste').hidden = paste.hidden;
  });
  document.querySelector('#load-paste').addEventListener('click', () => {
    try {
      const parsed = JSON.parse(paste.value);
      loadDataset(parsed, '粘贴数据');
    } catch (error) {
      state.dataParseError = `JSON 解析失败：${error.message}`;
      renderDataSummary();
    }
  });
  document.querySelector('#rerun-checks').addEventListener('click', renderSelfChecks);

  document.querySelector('#trace-slot').addEventListener('change', (e) => {
    state.traceSlot = e.target.value;
    renderTrace();
    updateRunCard(state.traceSlot);
  });
  document.querySelector('#pair-slot').addEventListener('change', (e) => {
    state.pairSlot = e.target.value;
    state.pairPage = 1;
    renderPairSection();
  });
  document.querySelector('#pair-filter').addEventListener('change', (e) => {
    state.pairFilter = e.target.value;
    state.pairPage = 1;
    renderPairTable();
  });
  let searchTimer;
  document.querySelector('#pair-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.pairSearch = e.target.value.trim().toLowerCase();
      state.pairPage = 1;
      renderPairTable();
    }, 160);
  });
  document.querySelector('#pair-prev').addEventListener('click', () => {
    state.pairPage = Math.max(1, state.pairPage - 1);
    renderPairTable();
  });
  document.querySelector('#pair-next').addEventListener('click', () => {
    state.pairPage += 1;
    renderPairTable();
  });
}

function loadDataset(dataset, name) {
  state.dataset = dataset;
  state.datasetName = name;
  state.dataParseError = null;
  state.selectedMonthBySlot = { A: null, B: null };
  state.pairPage = 1;
  renderDataSummary();
  scheduleRun('A', true);
  scheduleRun('B', true);
}

function renderDataSummary() {
  const host = document.querySelector('#data-summary');
  clear(host);
  if (state.dataParseError) {
    host.append(h('div', { class: 'diagnostic error' }, state.dataParseError));
    return;
  }
  const normalized = normalizeDataset(state.dataset);
  const d = normalized.data;
  const stats = [
    ['当前数据', state.datasetName, normalized.ok ? '校验通过' : '存在无效记录'],
    ['房屋数', d ? new Set(d.transactions.map((t) => t.propertyId).filter(Boolean)).size : '—', '虚构 ID'],
    ['成交记录', d?.transactions.length ?? '—', d ? `${d.transactions.filter((t) => t.valid).length} 有效` : ''],
    ['翻修记录', d?.renovations.length ?? '—', '持有期匹配'],
    ['拆分合并', d?.structureEvents.length ?? '—', '含错误实体样本'],
  ];
  for (const [label, value, hint] of stats) {
    host.append(h('div', { class: 'stat' }, [
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value', title: String(value) }, String(value)),
      h('div', { class: 'stat-hint' }, hint),
    ]));
  }
  if (normalized.errors.length) {
    host.append(h('div', { class: 'diagnostic warning', style: 'grid-column:1/-1' }, [
      h('strong', {}, `已隔离 ${normalized.errors.length} 条无效记录：`),
      h('span', {}, normalized.errors.slice(0, 4).map((e) => e.message).join('；')),
    ]));
  }
}

function configSelect(name, value, options) {
  return h('select', { name }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function renderConfigForm(slot) {
  const form = document.querySelector(`[data-config-form="${slot}"]`);
  clear(form);
  const cfg = state.runs[slot].config;

  const renovationField = h('label', { class: 'field' }, [
    h('span', {}, '翻修策略'),
    configSelect('renovationPolicy', cfg.renovationPolicy, [
      ['exclude', '排除持有期翻修配对'],
      ['independent', '作为独立 γ 项建模'],
      ['sensitivity', '只给 α=0–1 敏感性范围'],
      ['ignore', '不处理（对照）'],
    ]),
  ]);
  const weightingField = h('label', { class: 'field' }, [
    h('span', {}, '权重'),
    configSelect('weighting', cfg.weighting, [
      ['equal', '等权 OLS'],
      ['interval', '间隔 WLS：1/(A+B·月距)'],
    ]),
  ]);
  const baseField = h('label', { class: 'field' }, [
    h('span', {}, '基准月（空=各段首月）'),
    h('input', { type: 'month', name: 'baseMonth', value: cfg.baseMonth || '' }),
  ]);
  const confidenceField = h('label', { class: 'field' }, [
    h('span', {}, 'Wald 区间'),
    configSelect('confidence', String(cfg.confidence), [
      ['0.9', '90%'],
      ['0.95', '95%'],
      ['0.99', '99%'],
    ]),
  ]);
  const weightA = h('label', { class: 'field' }, [
    h('span', {}, '权重常数 A'),
    h('input', { type: 'number', name: 'weightA', value: cfg.weightA, min: '0', step: '0.001' }),
  ]);
  const weightB = h('label', { class: 'field' }, [
    h('span', {}, '权重月距系数 B'),
    h('input', { type: 'number', name: 'weightB', value: cfg.weightB, min: '0', step: '0.1' }),
  ]);
  const outlierField = h('label', { class: 'field' }, [
    h('span', {}, '异常成交'),
    configSelect('outlierPolicy', cfg.outlierPolicy, [
      ['flag', '检测并标记，保留'],
      ['exclude', '检测后剔除'],
      ['huber', 'Huber 降权'],
    ]),
  ]);
  const thresholdField = h('label', { class: 'field' }, [
    h('span', {}, '稳健 z 阈值'),
    h('input', { type: 'number', name: 'outlierThreshold', value: cfg.outlierThreshold, min: '2', max: '8', step: '0.1' }),
  ]);
  const clusterCheck = h('label', { class: 'field check' }, [
    h('input', { type: 'checkbox', name: 'clusterSE', checked: cfg.clusterSE }),
    h('span', {}, '同屋多对按房屋聚类，使用聚类稳健区间'),
  ]);
  const mergeCheck = h('label', { class: 'field check' }, [
    h('input', { type: 'checkbox', name: 'blockErroneousMerges', checked: cfg.blockErroneousMerges }),
    h('span', {}, '拦截已标记的错误实体合并（取消勾选仅用于污染演示）'),
  ]);
  const actions = h('div', { style: 'grid-column:1/-1;display:flex;gap:8px;align-items:center' }, [
    h('button', { type: 'submit', class: `btn ${slot === 'B' ? 'secondary' : ''}` }, '重新估算'),
    h('span', { class: 'stat-hint' }, '改动后自动在后台重估；结果按槽位隔离'),
  ]);

  form.append(
    renovationField,
    weightingField,
    baseField,
    confidenceField,
    weightA,
    weightB,
    outlierField,
    thresholdField,
    clusterCheck,
    mergeCheck,
    actions,
  );

  const read = () => {
    const fd = new FormData(form);
    Object.assign(state.runs[slot].config, {
      renovationPolicy: fd.get('renovationPolicy'),
      weighting: fd.get('weighting'),
      baseMonth: fd.get('baseMonth') || null,
      confidence: Number(fd.get('confidence')),
      weightA: Number(fd.get('weightA')) || 0,
      weightB: Number(fd.get('weightB')) || 0,
      outlierPolicy: fd.get('outlierPolicy'),
      outlierThreshold: Number(fd.get('outlierThreshold')) || 3.5,
      clusterSE: form.elements.clusterSE.checked,
      blockErroneousMerges: form.elements.blockErroneousMerges.checked,
    });
  };
  let debounceTimer;
  form.addEventListener('input', () => {
    read();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scheduleRun(slot), 260);
  });
  form.addEventListener('change', () => {
    read();
    clearTimeout(debounceTimer);
    scheduleRun(slot, true);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    read();
    scheduleRun(slot, true);
  });
}

function scheduleRun(slot, immediate = false) {
  const run = state.runs[slot];
  run.nonce += 1;
  const nonce = run.nonce;
  run.loading = true;
  run.error = null;
  updateRunStatus(slot);
  clearTimeout(run.timer);

  const execute = async () => {
    const payload = {
      jobId: `${slot}-${nonce}-${Date.now()}`,
      slot,
      nonce,
      dataset: state.dataset,
      config: { ...run.config },
    };
    if (worker) {
      worker.postMessage(payload);
    } else {
      try {
        const { analyzeRepeatSales } = await import('../core/repeatSales.js');
        const result = analyzeRepeatSales(state.dataset, run.config);
        handleWorkerMessage({ data: { type: 'analysis-complete', slot, nonce, result } });
      } catch (error) {
        handleWorkerMessage({ data: { type: 'analysis-error', slot, nonce, error: { message: error.message } } });
      }
    }
  };
  if (immediate) execute();
  else run.timer = setTimeout(execute, 240);
}

function handleWorkerMessage(event) {
  const msg = event.data ?? {};
  const { slot, nonce } = msg;
  if (slot !== 'A' && slot !== 'B') return;
  const run = state.runs[slot];
  if (!run || nonce !== run.nonce) {
    // Explicit isolation: an old rule's reply can never update the current slot.
    console.info(`Ignored stale worker result for ${slot} nonce ${nonce}; current ${run?.nonce}`);
    return;
  }
  run.loading = false;
  if (msg.type === 'analysis-error' || msg.ok === false && msg.error) {
    run.error = msg.error?.message ?? '分析失败';
    run.result = null;
  } else {
    run.result = msg.result;
    run.error = msg.result?.ok ? null : msg.result?.errors?.[0]?.message ?? '当前规则无法产生指数';
    if (state.selectedMonthBySlot[slot] == null && msg.result?.ok) {
      const best = [...msg.result.monthly]
        .filter((m) => m.estimable)
        .sort((a, b) => b.pairCount - a.pairCount)[0];
      if (best) state.selectedMonthBySlot[slot] = best.monthIndex;
    }
  }
  updateRunCard(slot);
  renderComparison();
  renderTrace();
  renderPairSection();
}

function updateRunStatus(slot) {
  const run = state.runs[slot];
  const card = document.querySelector(`#run-card-${slot}`);
  const pill = card.querySelector('[data-role="status-pill"]');
  const body = card.querySelector('[data-role="run-body"]');
  pill.className = 'run-status-pill';
  if (run.loading) {
    pill.classList.add('loading');
    pill.textContent = '后台重估中…';
  } else if (run.error && !run.result?.pairs?.length) {
    pill.classList.add('error');
    pill.textContent = '需要处理';
  } else if (run.result) {
    pill.classList.add('ready');
    pill.textContent = `完成 ${run.result.elapsedMs?.toFixed?.(0) ?? '—'} ms`;
  } else {
    pill.textContent = '待运行';
  }
  body.setAttribute('aria-busy', String(run.loading));
  card.querySelector('[data-role="run-subtitle"]').textContent = configSummary(run.config);
}

function configSummary(cfg) {
  const reno = { exclude: '翻修排除', independent: '翻修独立 γ', sensitivity: '翻修敏感性', ignore: '翻修不处理' }[cfg.renovationPolicy];
  const w = cfg.weighting === 'equal' ? '等权' : `WLS A=${cfg.weightA},B=${cfg.weightB}`;
  const out = { flag: '异常标记', exclude: '异常剔除', huber: 'Huber', keep: '不查异常' }[cfg.outlierPolicy];
  return `${reno} · ${w} · ${out} · ${cfg.clusterSE ? '聚类区间' : '模型区间'} · ${cfg.blockErroneousMerges ? '拦截错误合并' : '演示错误合并'}`;
}

function updateRunCard(slot) {
  updateRunStatus(slot);
  const run = state.runs[slot];
  const card = document.querySelector(`#run-card-${slot}`);
  renderKpis(card.querySelector('[data-role="kpis"]'), run.result);
  const chartHost = card.querySelector('[data-role="chart"]');
  renderRunChart(chartHost, run.result, {
    slot,
    color: currentSeriesColor(slot),
    selectedMonth: state.selectedMonthBySlot[slot],
    onSelectMonth: (month) => selectMonth(slot, month),
  });
  renderConnectionGraph(card.querySelector('[data-role="graph"]'), run.result);
  renderIndexTable(card.querySelector('[data-role="index-table"]'), run.result);
  renderDiagnostics(card.querySelector('[data-role="diagnostics"]'), run);
}

function renderKpis(host, result) {
  clear(host);
  const c = result?.counts;
  const estimable = result?.monthly?.filter((m) => m.estimable).length ?? 0;
  const comps = result?.graph?.components?.filter((x) => x.months.length > 1).length ?? 0;
  const items = [
    ['采用配对', c ? `${c.usedPairs}/${c.candidatePairs}` : '—', c ? `${c.properties} 屋` : ''],
    ['可估计月份', estimable, comps ? `${comps} 个连通段` : ''],
    ['翻修影响', c?.renovationPairs ?? '—', c ? `排除 ${c.renovationExcluded}` : ''],
    ['异常/错误链接', c ? `${c.outliers}/${c.erroneousLinks}` : '—', c ? `剔除 ${c.excludedOutliers}` : ''],
  ];
  for (const [label, value, sub] of items) {
    host.append(h('div', { class: 'kpi' }, [
      h('div', { class: 'kpi-label' }, label),
      h('div', { class: 'kpi-value' }, String(value)),
      h('div', { class: 'kpi-sub' }, sub),
    ]));
  }
}

function renderDiagnostics(host, run) {
  clear(host);
  if (run.error && !run.result) {
    host.append(h('div', { class: 'diagnostic error' }, run.error));
    return;
  }
  const diagnostics = run.result?.diagnostics ?? [];
  for (const d of diagnostics.slice(0, 12)) {
    host.append(h('div', { class: `diagnostic ${d.level ?? 'info'}` }, [
      h('div', {}, [
        h('strong', {}, d.message),
        h('div', { class: 'diag-code' }, d.code),
      ]),
    ]));
  }
}

function renderIndexTable(host, result) {
  clear(host);
  if (!result?.ok) {
    host.append(h('div', { class: 'empty-note' }, result?.errors?.[0]?.message ?? '暂无可视化指数表。'));
    return;
  }
  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '月份'), h('th', { class: 'num' }, '指数'), h('th', { class: 'num' }, '95% 区间'),
      h('th', { class: 'num' }, '相邻月涨跌'), h('th', { class: 'num' }, '配对'), h('th', { class: 'num' }, '房屋'), h('th', {}, '连通段'),
    ])),
  ]);
  const tbody = h('tbody');
  result.monthly.forEach((m, i) => {
    let change = '—';
    if (m.estimable && i > 0) {
      const prev = result.monthly[i - 1];
      if (prev.estimable && prev.componentId === m.componentId) change = fmtPercent(m.logIndex - prev.logIndex);
    }
    tbody.append(h('tr', {}, [
      h('td', {}, m.month),
      h('td', { class: 'num' }, m.estimable ? fmtNumber(m.index, 1) : '不可估计'),
      h('td', { class: 'num' }, m.estimable ? `[${fmtNumber(m.ciLow, 1)}, ${fmtNumber(m.ciHigh, 1)}]` : '—'),
      h('td', { class: 'num' }, change),
      h('td', { class: 'num' }, String(m.pairCount ?? 0)),
      h('td', { class: 'num' }, String(m.propertyCount ?? 0)),
      h('td', {}, m.componentId ?? '—'),
    ]));
  });
  table.append(tbody);
  host.append(table);
}

function selectMonth(slot, monthIndex) {
  state.selectedMonthBySlot[slot] = monthIndex;
  state.traceSlot = slot;
  document.querySelector('#trace-slot').value = slot;
  updateRunCard(slot);
  renderTrace();
  renderComparison();
  document.querySelector('[data-role="trace"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderComparison() {
  const host = document.querySelector('[data-role="comparison-chart"]');
  clear(host);
  renderComparisonChart(host, [
    { key: 'A', label: configShort(state.runs.A.config), result: state.runs.A.result, color: currentSeriesColor('A') },
    { key: 'B', label: configShort(state.runs.B.config), result: state.runs.B.result, color: currentSeriesColor('B') },
  ], {
    onSelectMonth: (i) => {
      state.selectedMonthBySlot.A = i;
      state.selectedMonthBySlot.B = i;
      state.traceSlot = 'A';
      document.querySelector('#trace-slot').value = 'A';
      updateRunCard('A');
      updateRunCard('B');
      renderTrace();
    },
  });
  renderComparisonTable();
  renderPairDiff();
}

function configShort(cfg) {
  return { exclude: '排除翻修', independent: '翻修γ', sensitivity: '敏感性', ignore: '忽略翻修' }[cfg.renovationPolicy] ?? cfg.renovationPolicy;
}

function renderComparisonTable() {
  const host = document.querySelector('[data-role="comparison-table"]');
  clear(host);
  const a = state.runs.A.result;
  const b = state.runs.B.result;
  if (!a?.ok || !b?.ok) {
    host.append(h('div', { class: 'empty-note' }, '等待 A、B 两份完整计算成功。'));
    return;
  }
  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '月份'),
      h('th', { class: 'num' }, 'A 指数'), h('th', { class: 'num' }, 'A 区间'),
      h('th', { class: 'num' }, 'B 指数'), h('th', { class: 'num' }, 'B 区间'),
      h('th', { class: 'num' }, 'B/A−1'),
    ])),
    h('tbody', {}, a.monthLabels.map((month, i) => {
      const ma = a.monthly[i];
      const mb = b.monthly[i];
      const delta = ma.estimable && mb.estimable ? Math.exp(mb.logIndex - ma.logIndex) - 1 : null;
      return h('tr', {}, [
        h('td', {}, month),
        h('td', { class: 'num' }, ma.estimable ? fmtNumber(ma.index, 1) : '断'),
        h('td', { class: 'num' }, ma.estimable ? `[${fmtNumber(ma.ciLow, 1)},${fmtNumber(ma.ciHigh, 1)}]` : '—'),
        h('td', { class: 'num' }, mb.estimable ? fmtNumber(mb.index, 1) : '断'),
        h('td', { class: 'num' }, mb.estimable ? `[${fmtNumber(mb.ciLow, 1)},${fmtNumber(mb.ciHigh, 1)}]` : '—'),
        h('td', { class: 'num' }, delta == null ? '—' : `${delta > 0 ? '+' : ''}${fmtNumber(delta * 100, 2)}%`),
      ]);
    })),
  ]);
  host.append(table);
}

function renderPairDiff() {
  const host = document.querySelector('[data-role="pair-diff"]');
  clear(host);
  const a = state.runs.A.result;
  const b = state.runs.B.result;
  if (!a || !b) return;
  const usedA = new Set(a.pairs.filter((p) => p.used).map((p) => p.id));
  const usedB = new Set(b.pairs.filter((p) => p.used).map((p) => p.id));
  const onlyA = [...usedA].filter((id) => !usedB.has(id));
  const onlyB = [...usedB].filter((id) => !usedA.has(id));
  host.append(
    h('div', { class: 'diff-card' }, [
      h('h4', {}, '配对集合差异'),
      h('div', {}, `共同采用 ${usedA.size - onlyA.length}；仅 A ${onlyA.length}；仅 B ${onlyB.length}`),
      h('ul', {}, onlyA.slice(0, 8).map((id) => h('li', {}, `A only：${id}`))),
      h('ul', {}, onlyB.slice(0, 8).map((id) => h('li', {}, `B only：${id}`))),
    ]),
    h('div', { class: 'diff-card' }, [
      h('h4', {}, '隔离保证'),
      h('div', {}, 'Worker 消息按 slot + nonce 校验；A 配置只会写入 A 图表，B 配置只会写入 B 图表。'),
      h('ul', {}, [
        h('li', {}, `A nonce ${state.runs.A.nonce}，${a.ok ? '完整结果已返回' : '结果不可估计'}`),
        h('li', {}, `B nonce ${state.runs.B.nonce}，${b.ok ? '完整结果已返回' : '结果不可估计'}`),
        h('li', {}, '比较表只读取两个已完成结果，不反向修改任一规则。'),
      ]),
    ]),
  );
}

function renderTrace() {
  const host = document.querySelector('[data-role="trace"]');
  if (!host) return;
  clear(host);
  state.traceSlot = document.querySelector('#trace-slot').value || state.traceSlot;
  const slot = state.traceSlot;
  const result = state.runs[slot].result;
  let monthIndex = state.selectedMonthBySlot[slot];

  if (!result?.ok) {
    host.append(h('div', { class: 'empty-note' }, '运行成功后，可从指数图点击月份追踪贡献房屋。'));
    return;
  }
  const options = result.monthly.filter((m) => m.estimable).map((m) => h('option', { value: m.monthIndex, selected: m.monthIndex === monthIndex }, m.month));
  if (monthIndex == null || !result.monthly[monthIndex]?.estimable) {
    monthIndex = result.monthly.find((m) => m.estimable)?.monthIndex;
    state.selectedMonthBySlot[slot] = monthIndex ?? null;
  }
  if (monthIndex == null) {
    host.append(h('div', { class: 'empty-note' }, '没有可追踪的估计月份。'));
    return;
  }
  const month = result.monthly[monthIndex];
  const select = h('select', {
    'aria-label': '选择追踪月份',
    onChange: (e) => {
      state.selectedMonthBySlot[slot] = Number(e.target.value);
      renderTrace();
      updateRunCard(slot);
    },
  }, options);

  host.append(
    h('div', { class: 'trace-head' }, [
      h('span', { class: `badge badge-${slot.toLowerCase()}` }, `结果 ${slot}`),
      select,
      h('strong', {}, month.month),
      h('span', { class: 'badge badge-good' }, `指数 ${fmtNumber(month.index, 1)}`),
      h('span', { class: 'badge' }, `95% CI ${fmtNumber(month.ciLow, 1)}–${fmtNumber(month.ciHigh, 1)}`),
      h('span', { class: 'badge' }, `${month.pairCount} 对 / ${month.propertyCount} 屋 / ${month.componentId}`),
    ]),
  );

  const pairIds = new Set(month.contributionPairIds ?? []);
  const pairs = result.pairs.filter((p) => pairIds.has(p.id));
  if (!pairs.length) {
    host.append(h('div', { class: 'empty-note' }, '该月没有最终采用的配对。'));
    return;
  }
  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '房屋/配对'), h('th', {}, '角色'), h('th', {}, '两次成交'),
      h('th', { class: 'num' }, '价格比'), h('th', { class: 'num' }, 'log r'),
      h('th', { class: 'num' }, '权重'), h('th', { class: 'num' }, '残差/z'), h('th', {}, '翻修/事件'),
    ])),
    h('tbody', {}, pairs.map((p) => {
      const role = p.monthFromIndex === monthIndex ? '买入月 −1' : p.monthToIndex === monthIndex ? '卖出月 +1' : '—';
      return h('tr', {}, [
        h('td', {}, [h('strong', {}, p.propertyId), h('div', { class: 'stat-hint' }, p.id)]),
        h('td', {}, role),
        h('td', {}, `${p.firstDate} ${fmtNumber(p.firstPrice, 0)} → ${p.secondDate} ${fmtNumber(p.secondPrice, 0)}`),
        h('td', { class: 'num' }, fmtNumber(p.priceRatio, 4)),
        h('td', { class: 'num' }, fmtNumber(p.logRatio, 4)),
        h('td', { class: 'num' }, fmtNumber(p.fitWeight ?? p.baseWeight, 3)),
        h('td', { class: 'num' }, Number.isFinite(p.residual) ? `${fmtNumber(p.residual, 3)} / z=${fmtNumber(p.robustZ, 2)}` : '—'),
        h('td', {}, [
          p.renovationIds?.length ? h('span', { class: 'badge badge-warning' }, `翻修 ${p.renovationIds.length}，${fmtNumber(p.renovationCost, 0)}`) : null,
          p.barrierEventIds?.length ? h('span', { class: 'badge badge-serious' }, p.barrierEventIds.join(',')) : null,
          p.crossEntity ? h('span', { class: 'badge badge-critical' }, '跨实体') : null,
        ]),
      ]);
    })),
  ]);
  host.append(h('div', { class: 'table-scroll' }, table));
}

function renderPairSection() {
  document.querySelector('#pair-slot').value = state.pairSlot;
  renderPairSummary();
  renderPairTable();
}

function renderPairSummary() {
  const host = document.querySelector('[data-role="pair-summary"]');
  clear(host);
  const result = state.runs[state.pairSlot].result;
  if (!result) return;
  const c = result.counts ?? {};
  const chips = [
    [`候选 ${c.candidatePairs ?? 0}`, ''],
    [`采用 ${c.usedPairs ?? 0}`, 'good'],
    [`同日 ${c.sameDayPairs ?? 0}`, 'warning'],
    ['结构阻断 ' + (c.structureBarriers ?? 0), 'serious'],
    [`翻修 ${c.renovationPairs ?? 0}/排除 ${c.renovationExcluded ?? 0}`, 'warning'],
    [`异常 ${c.outliers ?? 0}`, 'critical'],
    [`错误链接 ${c.erroneousLinks ?? 0}`, 'critical'],
  ];
  for (const [text, tone] of chips) host.append(h('span', { class: `badge badge-${tone || 'neutral'}` }, text));
}

function pairMatchesFilter(p, filter) {
  switch (filter) {
    case 'used': return p.used;
    case 'impacted': return !p.used;
    case 'renovation': return p.renovationIds?.length;
    case 'structure': return p.barrierEventIds?.length || p.exclusionReasons?.includes('structure_barrier');
    case 'outlier': return p.outlier || p.exclusionReasons?.includes('outlier');
    case 'badmerge': return p.crossEntity;
    case 'sameday': return p.sameDay || p.sameMonth;
    default: return true;
  }
}

function renderPairTable() {
  const host = document.querySelector('[data-role="pair-table"]');
  if (!host) return;
  clear(host);
  const result = state.runs[state.pairSlot].result;
  document.querySelector('#pair-slot').value = state.pairSlot;
  document.querySelector('#pair-filter').value = state.pairFilter;
  if (!result?.pairs) {
    host.append(h('div', { class: 'empty-note' }, '运行后显示配对。'));
    document.querySelector('[data-role="page-info"]').textContent = '';
    return;
  }
  const filtered = result.pairs.filter((p) => {
    if (!pairMatchesFilter(p, state.pairFilter)) return false;
    if (!state.pairSearch) return true;
    const haystack = [p.id, p.propertyId, p.firstDate, p.secondDate, p.monthFrom, p.monthTo, ...(p.exclusionReasons ?? [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(state.pairSearch);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.pairPage = Math.min(state.pairPage, pageCount);
  const start = (state.pairPage - 1) * PAGE_SIZE;
  const rows = filtered.slice(start, start + PAGE_SIZE);
  document.querySelector('[data-role="page-info"]').textContent =
    `${filtered.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, filtered.length)} / ${filtered.length}，第 ${state.pairPage}/${pageCount} 页`;

  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '配对/房屋'), h('th', {}, '相邻有效成交'), h('th', {}, '月距'),
      h('th', { class: 'num' }, '金额比/log'), h('th', {}, '翻修'), h('th', { class: 'num' }, '权重'),
      h('th', {}, '异常'), h('th', {}, '规则状态与影响原因'),
    ])),
    h('tbody', {}, rows.map(renderPairRow)),
  ]);
  host.append(table);
}

function renderPairRow(p) {
  const reasonBadges = (p.exclusionReasons ?? []).map((code) => {
    const [label, tone] = REASON_META[code] ?? [code, 'warning'];
    return h('span', { class: `badge badge-${tone}` }, label);
  });
  if (p.used) reasonBadges.unshift(h('span', { class: 'badge badge-good' }, '最终采用'));
  else if (!reasonBadges.length) reasonBadges.push(h('span', { class: 'badge badge-warning' }, '未采用'));

  return h('tr', { dataset: { pairId: p.id } }, [
    h('td', {}, [h('strong', {}, p.propertyId), h('div', { class: 'stat-hint' }, p.id)]),
    h('td', {}, [
      h('div', {}, `${p.firstDate} · ${fmtNumber(p.firstPrice, 0)}`),
      h('div', {}, `${p.secondDate} · ${fmtNumber(p.secondPrice, 0)}`),
      p.sameDay ? h('span', { class: 'badge badge-warning' }, '同日') : null,
    ]),
    h('td', {}, p.sameMonth ? '同月' : `${p.monthSpan} 月`),
    h('td', { class: 'num' }, [h('div', {}, fmtNumber(p.priceRatio, 4)), h('div', { class: 'stat-hint' }, fmtNumber(p.logRatio, 4))]),
    h('td', {}, p.renovationIds?.length
      ? `${p.renovationIds.length} 笔 / ${fmtNumber(p.renovationCost, 0)}`
      : '—'),
    h('td', { class: 'num' }, fmtNumber(p.fitWeight ?? p.baseWeight, 3)),
    h('td', {}, p.outlier
      ? h('span', { class: 'badge badge-critical' }, `z=${fmtNumber(p.robustZ, 2)}`)
      : Number.isFinite(p.robustZ) ? fmtNumber(p.robustZ, 2) : '—'),
    h('td', {}, h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, reasonBadges)),
  ]);
}

function renderSelfChecks() {
  const host = document.querySelector('#self-checks');
  clear(host);
  const result = runSelfChecks();
  host.append(h('div', { style: 'grid-column:1/-1;display:flex;gap:10px;align-items:center;margin-bottom:4px' }, [
    h('span', { class: `badge badge-${result.failed ? 'critical' : 'good'}` }, result.failed ? `${result.failed} 项失败` : '全部通过'),
    h('strong', {}, `${result.passed}/${result.checks.length} 个可算清断言通过`),
  ]));
  for (const check of result.checks) {
    host.append(h('div', { class: 'check' }, [
      h('div', { class: 'check-head' }, [
        h('span', {}, check.name),
        h('span', { class: `badge badge-${check.pass ? 'good' : 'critical'}` }, check.pass ? 'PASS' : 'FAIL'),
      ]),
      h('div', { class: 'check-id' }, check.id),
      h('div', { class: 'check-detail' }, check.details),
      check.pass ? null : h('pre', {}, JSON.stringify({ expected: check.expected, actual: check.actual }, null, 2)),
    ]));
  }
}

function renderAllResults() {
  updateRunCard('A');
  updateRunCard('B');
  renderComparison();
  renderTrace();
  renderPairSection();
}

function init() {
  initTheme();
  renderSampleButtons();
  bindGlobalControls();
  renderConfigForm('A');
  renderConfigForm('B');
  renderSelfChecks();
  renderDataSummary();
  renderPairSection();
  scheduleRun('A', true);
  scheduleRun('B', true);
}

init();
