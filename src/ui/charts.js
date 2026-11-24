import { clear, h, svg } from './dom.js';

const W = 880;
const H = 390;
const M = { top: 24, right: 28, bottom: 64, left: 62 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

function monthScale(monthCount) {
  return (i) => M.left + (monthCount <= 1 ? PLOT_W / 2 : (i / (monthCount - 1)) * PLOT_W);
}

function buildYScale(values) {
  const finite = values.filter(Number.isFinite);
  let min = Math.min(...finite, 0);
  let max = Math.max(...finite, 0);
  if (min === max) {
    min -= 0.05;
    max += 0.05;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;
  const y = (v) => M.top + (1 - (v - min) / (max - min)) * PLOT_H;
  const ticks = [];
  const count = 5;
  for (let i = 0; i <= count; i += 1) ticks.push(min + ((max - min) * i) / count);
  return { y, min, max, ticks };
}

function indexTick(logTick) {
  return Math.round(100 * Math.exp(logTick));
}

function validEstimate(m) {
  return m && m.estimable && Number.isFinite(m.logIndex);
}

function adjacentPair(monthly, i) {
  const a = monthly[i - 1];
  const b = monthly[i];
  return validEstimate(a) && validEstimate(b) && a.componentId === b.componentId;
}

function linePath(monthly, x, y) {
  let d = '';
  for (let i = 0; i < monthly.length; i += 1) {
    const m = monthly[i];
    if (!validEstimate(m)) continue;
    if (i > 0 && adjacentPair(monthly, i)) d += ` L ${x(i).toFixed(2)} ${y(m.logIndex).toFixed(2)}`;
    else d += ` M ${x(i).toFixed(2)} ${y(m.logIndex).toFixed(2)}`;
  }
  return d;
}

function ciAreaPath(monthly, x, y) {
  const runs = [];
  let run = [];
  for (let i = 0; i < monthly.length; i += 1) {
    if (validEstimate(monthly[i])) {
      if (run.length && i > 0 && !adjacentPair(monthly, i)) {
        runs.push(run);
        run = [];
      }
      run.push(i);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  return runs
    .filter((r) => r.length >= 2)
    .map((indices) => {
      const top = indices
        .map((i, j) => `${j === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(monthly[i].ciLogHigh).toFixed(2)}`)
        .join(' ');
      const bottom = [...indices]
        .reverse()
        .map((i) => `L ${x(i).toFixed(2)} ${y(monthly[i].ciLogLow).toFixed(2)}`)
        .join(' ');
      return `${top} ${bottom} Z`;
    })
    .join(' ');
}

function bandPath(upperByMonth, lowerByMonth, monthCount, x, y) {
  const runs = [];
  let run = [];
  for (let i = 0; i < monthCount; i += 1) {
    const u = upperByMonth.get(i);
    const l = lowerByMonth.get(i);
    const ok = u && l && Number.isFinite(u.logIndex) && Number.isFinite(l.logIndex);
    if (ok) {
      if (run.length && i > 0 && !(upperByMonth.get(i - 1) && lowerByMonth.get(i - 1))) {
        runs.push(run);
        run = [];
      }
      run.push(i);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs
    .filter((r) => r.length >= 2)
    .map((indices) => {
      const top = indices
        .map((i, j) => `${j === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(upperByMonth.get(i).logIndex).toFixed(2)}`)
        .join(' ');
      const bottom = [...indices]
        .reverse()
        .map((i) => `L ${x(i).toFixed(2)} ${y(lowerByMonth.get(i).logIndex).toFixed(2)}`)
        .join(' ');
      return `${top} ${bottom} Z`;
    })
    .join(' ');
}

function makeTooltip(container) {
  const tip = h('div', { class: 'chart-tooltip', role: 'status', 'aria-live': 'polite' });
  container.append(tip);
  return tip;
}

function positionTooltip(tip, container, event) {
  const box = container.getBoundingClientRect();
  let left = event.clientX - box.left + 14;
  let top = event.clientY - box.top + 12;
  if (left + 260 > box.width) left = event.clientX - box.left - 250;
  if (top + 150 > box.height) top -= 120;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function tooltipRow(label, value, colorVar) {
  return h('div', { class: 'tooltip-row' }, [
    h('span', { class: 'tooltip-key' }, [
      colorVar ? h('i', { class: 'tooltip-line', style: `background:${colorVar}` }) : null,
      label,
    ]),
    h('strong', {}, value),
  ]);
}

function monthLabel(result, i) {
  return result.monthLabels?.[i] ?? result.monthly?.[i]?.month ?? `M${i + 1}`;
}

function renderEmpty(container, message) {
  clear(container);
  container.append(h('div', { class: 'chart-empty' }, message));
}

export function renderRunChart(container, result, options = {}) {
  clear(container);
  if (!result?.ok || !result.monthly?.some(validEstimate)) {
    renderEmpty(container, result?.errors?.[0]?.message ?? '当前规则下没有可绘制的连通指数。');
    return;
  }

  const color = options.color ?? 'var(--series-a)';
  const wrap = h('div', { class: 'svg-wrap' });
  container.append(wrap);
  const legend = h('div', { class: 'chart-legend' }, [
    h('span', { class: 'legend-item' }, [h('i', { class: 'legend-line', style: `background:${color}` }), '指数（对数轴）']),
    h('span', { class: 'legend-item' }, [h('i', { class: 'legend-box ci', style: `background:${color}` }), '95% 区间']),
    result.sensitivity
      ? h('span', { class: 'legend-item' }, [h('i', { class: 'legend-box band', style: `background:${color}` }), '翻修敏感性范围'])
      : null,
    h('span', { class: 'legend-note' }, '断点 = 月份图不连通或日历月缺失，不做插值'),
  ]);
  container.prepend(legend);

  const monthly = result.monthly;
  const n = monthly.length;
  const x = monthScale(n);
  const upperSens = new Map((result.sensitivity?.upper?.monthly ?? []).map((m) => [m.monthIndex, m]));
  const lowerSens = new Map((result.sensitivity?.lower?.monthly ?? []).map((m) => [m.monthIndex, m]));
  const yScale = buildYScale([
    ...monthly.filter(validEstimate).flatMap((m) => [m.logIndex, m.ciLogLow, m.ciLogHigh]),
    ...(result.sensitivity?.upper?.monthly ?? []).map((m) => m.logIndex),
    ...(result.sensitivity?.lower?.monthly ?? []).map((m) => m.logIndex),
  ]);
  const y = yScale.y;

  const svgRoot = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'index-svg',
    role: 'img',
    'aria-label': `${options.slot ?? '计算'} 的月度重复成交指数，断点表示不可识别的月份`,
  });

  for (const tick of yScale.ticks) {
    svgRoot.append(
      svg('line', { x1: M.left, x2: W - M.right, y1: y(tick), y2: y(tick), class: 'grid-line' }),
      svg('text', { x: M.left - 10, y: y(tick) + 4, 'text-anchor': 'end', class: 'axis-text', text: String(indexTick(tick)) }),
    );
  }
  svgRoot.append(svg('line', { x1: M.left, x2: W - M.right, y1: M.top + PLOT_H, y2: M.top + PLOT_H, class: 'axis-line' }));

  const labelEvery = Math.ceil(n / 13);
  for (let i = 0; i < n; i += 1) {
    if (i % labelEvery !== 0 && i !== n - 1) continue;
    const label = monthLabel(result, i);
    const tx = x(i);
    svgRoot.append(
      svg('line', { x1: tx, x2: tx, y1: M.top + PLOT_H, y2: M.top + PLOT_H + 5, class: 'axis-line' }),
      svg('text', {
        x: tx,
        y: M.top + PLOT_H + 20,
        'text-anchor': 'end',
        class: 'axis-text x-label',
        transform: `rotate(-38 ${tx} ${M.top + PLOT_H + 20})`,
        text: label,
      }),
    );
  }

  if (result.sensitivity) {
    svgRoot.append(
      svg('path', { d: bandPath(upperSens, lowerSens, n, x, y), class: 'sensitivity-band', fill: color }),
    );
  }
  svgRoot.append(svg('path', { d: ciAreaPath(monthly, x, y), class: 'ci-area', fill: color }));

  for (let i = 0; i < n; i += 1) {
    const m = monthly[i];
    if (!validEstimate(m)) continue;
    const cx = x(i);
    svgRoot.append(
      svg('line', { x1: cx, x2: cx, y1: y(m.ciLogLow), y2: y(m.ciLogHigh), class: 'ci-whisker', stroke: color }),
      svg('line', { x1: cx - 5, x2: cx + 5, y1: y(m.ciLogLow), y2: y(m.ciLogLow), class: 'ci-cap', stroke: color }),
      svg('line', { x1: cx - 5, x2: cx + 5, y1: y(m.ciLogHigh), y2: y(m.ciLogHigh), class: 'ci-cap', stroke: color }),
    );
  }

  svgRoot.append(svg('path', { d: linePath(monthly, x, y), class: 'index-line', stroke: color }));

  const crosshair = svg('line', { x1: 0, x2: 0, y1: M.top, y2: M.top + PLOT_H, class: 'crosshair', visibility: 'hidden' });
  const crossDot = svg('circle', { r: 5.5, class: 'cross-dot', fill: color, visibility: 'hidden' });
  svgRoot.append(crosshair, crossDot);

  for (let i = 0; i < n; i += 1) {
    const m = monthly[i];
    if (!validEstimate(m)) {
      svgRoot.append(
        svg('circle', { cx: x(i), cy: M.top + PLOT_H, r: 2.5, class: 'isolated-tick' }),
      );
      continue;
    }
    const selected = options.selectedMonth === i;
    svgRoot.append(
      svg('circle', { cx: x(i), cy: y(m.logIndex), r: selected ? 7 : 4.5, class: selected ? 'index-point selected' : 'index-point', stroke: color }),
    );
    const hit = svg('circle', {
      cx: x(i),
      cy: y(m.logIndex),
      r: 18,
      class: 'point-hit',
      tabindex: 0,
      role: 'button',
      'aria-label': `${m.month}，指数 ${m.index.toFixed(1)}，${m.pairCount} 个配对；回车追踪房屋`,
    });
    hit.addEventListener('focus', () => showMonth(i, x(i), y(m.logIndex)));
    hit.addEventListener('blur', hideTip);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        options.onSelectMonth?.(i);
      }
    });
    svgRoot.append(hit);
  }

  const tip = makeTooltip(container);
  function hideTip() {
    tip.style.opacity = '0';
    crosshair.setAttribute('visibility', 'hidden');
    crossDot.setAttribute('visibility', 'hidden');
  }
  function showMonth(i, pointerX, pointerY, event) {
    const m = monthly[i];
    if (!m) return;
    crosshair.setAttribute('x1', x(i));
    crosshair.setAttribute('x2', x(i));
    crosshair.setAttribute('visibility', 'visible');
    if (validEstimate(m)) {
      crossDot.setAttribute('cx', x(i));
      crossDot.setAttribute('cy', y(m.logIndex));
      crossDot.setAttribute('visibility', 'visible');
    } else {
      crossDot.setAttribute('visibility', 'hidden');
    }
    clear(tip);
    tip.append(
      h('div', { class: 'tooltip-title' }, monthLabel(result, i)),
      validEstimate(m)
        ? tooltipRow('指数 / 95% 区间', `${m.index.toFixed(1)} [${m.ciLow.toFixed(1)}, ${m.ciHigh.toFixed(1)}]`, color)
        : h('div', { class: 'tooltip-row' }, h('strong', {}, '不可估计 / 未连接')),
      tooltipRow('贡献配对 / 房屋', `${m.pairCount} / ${m.propertyCount}`),
      m.componentId ? tooltipRow('连通段', m.componentId) : null,
      result.sensitivity && upperSens.has(i)
        ? tooltipRow('敏感性范围', `${lowerSens.get(i).index.toFixed(1)}–${upperSens.get(i).index.toFixed(1)}`)
        : null,
      h('div', { class: 'tooltip-hint' }, '点击追踪到贡献房屋'),
    );
    tip.style.opacity = '1';
    if (event) positionTooltip(tip, container, event);
    else {
      const box = container.getBoundingClientRect();
      const sx = (pointerX / W) * box.width;
      tip.style.left = `${Math.min(box.width - 250, Math.max(8, sx + 14))}px`;
      tip.style.top = `${M.top + 8}px`;
    }
  }

  svgRoot.addEventListener('pointermove', (event) => {
    const rect = svgRoot.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - M.left) / (PLOT_W / Math.max(1, n - 1)))));
    showMonth(i, x(i), validEstimate(monthly[i]) ? y(monthly[i].logIndex) : M.top + PLOT_H, event);
  });
  svgRoot.addEventListener('pointerleave', hideTip);
  svgRoot.addEventListener('click', (event) => {
    const rect = svgRoot.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - M.left) / (PLOT_W / Math.max(1, n - 1)))));
    options.onSelectMonth?.(i);
  });

  wrap.append(svgRoot);
}

export function renderComparisonChart(container, items, options = {}) {
  clear(container);
  const usable = items.filter((item) => item.result?.ok);
  if (usable.length < 2) {
    renderEmpty(container, 'A、B 两份完整计算都成功后，这里显示同月份对比。');
    return;
  }
  const first = usable[0].result;
  const n = first.monthLabels.length;
  const x = monthScale(n);
  const yScale = buildYScale(
    usable.flatMap((item) =>
      item.result.monthly.filter(validEstimate).flatMap((m) => [m.logIndex, m.ciLogLow, m.ciLogHigh]),
    ),
  );
  const y = yScale.y;
  const wrap = h('div', { class: 'svg-wrap' });
  container.append(
    h('div', { class: 'chart-legend' }, usable.map((item) =>
      h('span', { class: 'legend-item' }, [h('i', { class: 'legend-line', style: `background:${item.color}` }), `${item.key}：${item.label}`]),
    )),
    wrap,
  );

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'index-svg', role: 'img', 'aria-label': 'A 与 B 两份指数对比' });
  for (const tick of yScale.ticks) {
    root.append(
      svg('line', { x1: M.left, x2: W - M.right, y1: y(tick), y2: y(tick), class: 'grid-line' }),
      svg('text', { x: M.left - 10, y: y(tick) + 4, 'text-anchor': 'end', class: 'axis-text', text: String(indexTick(tick)) }),
    );
  }
  root.append(svg('line', { x1: M.left, x2: W - M.right, y1: M.top + PLOT_H, y2: M.top + PLOT_H, class: 'axis-line' }));
  const labelEvery = Math.ceil(n / 13);
  for (let i = 0; i < n; i += 1) {
    if (i % labelEvery !== 0) continue;
    root.append(svg('text', {
      x: x(i),
      y: M.top + PLOT_H + 20,
      'text-anchor': 'end',
      class: 'axis-text x-label',
      transform: `rotate(-38 ${x(i)} ${M.top + PLOT_H + 20})`,
      text: first.monthLabels[i],
    }));
  }

  for (const item of usable) {
    const monthly = item.result.monthly;
    root.append(svg('path', { d: ciAreaPath(monthly, x, y), class: 'ci-area compare', fill: item.color }));
    root.append(svg('path', { d: linePath(monthly, x, y), class: 'index-line compare', stroke: item.color }));
    for (let i = 0; i < n; i += 1) {
      const m = monthly[i];
      if (validEstimate(m)) root.append(svg('circle', { cx: x(i), cy: y(m.logIndex), r: 3.8, class: 'index-point compare', stroke: item.color }));
    }
  }

  const crosshair = svg('line', { x1: 0, x2: 0, y1: M.top, y2: M.top + PLOT_H, class: 'crosshair', visibility: 'hidden' });
  root.append(crosshair);
  const tip = makeTooltip(container);
  root.addEventListener('pointermove', (event) => {
    const rect = root.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - M.left) / (PLOT_W / Math.max(1, n - 1)))));
    crosshair.setAttribute('x1', x(i));
    crosshair.setAttribute('x2', x(i));
    crosshair.setAttribute('visibility', 'visible');
    clear(tip);
    tip.append(h('div', { class: 'tooltip-title' }, first.monthLabels[i]));
    for (const item of usable) {
      const m = item.result.monthly[i];
      tip.append(validEstimate(m)
        ? tooltipRow(`${item.key} 指数`, `${m.index.toFixed(1)} [${m.ciLow.toFixed(1)}, ${m.ciHigh.toFixed(1)}]`, item.color)
        : tooltipRow(`${item.key} 指数`, '不可估计', item.color));
    }
    tip.append(h('div', { class: 'tooltip-hint' }, '同一基准月/连通段内比较；区间重叠不构成显著性检验'));
    tip.style.opacity = '1';
    positionTooltip(tip, container, event);
  });
  root.addEventListener('pointerleave', () => {
    tip.style.opacity = '0';
    crosshair.setAttribute('visibility', 'hidden');
  });
  root.addEventListener('click', (event) => {
    const rect = root.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - M.left) / (PLOT_W / Math.max(1, n - 1)))));
    options.onSelectMonth?.(i);
  });
  wrap.append(root);
}

export function renderConnectionGraph(container, result) {
  clear(container);
  if (!result?.ok) {
    container.append(h('div', { class: 'chart-empty small' }, '尚无月份连接图。'));
    return;
  }
  const n = result.monthLabels.length;
  const width = W;
  const height = 150;
  const top = 34;
  const x = monthScale(n);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'graph-svg', role: 'img', 'aria-label': '月份连接图，每条弧是一对贡献成交' });
  const edges = result.graph?.edges ?? [];
  const maxDraw = 900;
  const drawnEdges = edges.slice(0, maxDraw);
  for (const edge of drawnEdges) {
    if (!Number.isInteger(edge.from) || !Number.isInteger(edge.to)) continue;
    const x1 = x(edge.from);
    const x2 = x(edge.to);
    const span = Math.abs(edge.to - edge.from);
    const control = top - Math.min(26, 5 + span * 2.2);
    root.append(svg('path', {
      d: `M ${x1} ${top} Q ${(x1 + x2) / 2} ${control} ${x2} ${top}`,
      class: edge.outlier ? 'edge-path outlier' : 'edge-path',
    }));
  }
  for (let i = 0; i < n; i += 1) {
    const estimable = result.monthly[i]?.estimable;
    root.append(svg('circle', { cx: x(i), cy: top, r: estimable ? 4 : 3, class: estimable ? 'graph-node' : 'graph-node isolated' }));
    if (i % Math.ceil(n / 16) === 0) {
      root.append(svg('text', { x: x(i), y: height - 18, 'text-anchor': 'middle', class: 'axis-text', text: result.monthLabels[i].slice(2) }));
    }
  }
  container.append(
    root,
    edges.length > maxDraw ? h('div', { class: 'graph-note' }, `连接较多，仅绘制前 ${maxDraw} 条；计算与表格仍使用全部 ${edges.length} 对。`) : null,
  );
}
