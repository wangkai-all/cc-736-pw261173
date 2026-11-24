import { enumerateMonths, monthKeyFromDate } from './dates.js';
import { buildMonthComponents } from './monthGraph.js';
import { fitWLS, zForConfidence } from './linalg.js';
import { buildPairCandidates, normalizeDataset } from './pairs.js';

export const DEFAULT_CONFIG = Object.freeze({
  baseMonth: null,
  weighting: 'equal', // equal | interval
  weightA: 0,
  weightB: 1,
  clusterSE: true,
  confidence: 0.95,
  renovationPolicy: 'exclude', // exclude | independent | sensitivity | ignore
  outlierPolicy: 'flag', // flag | exclude | huber | keep
  outlierThreshold: 3.5,
  outlierAbsoluteLog: Math.log(2),
  huberC: 1.345,
  blockErroneousMerges: true,
  sensitivityRecoveryLow: 0,
  sensitivityRecoveryHigh: 1,
});

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function robustResidualScale(residuals) {
  const finite = residuals.filter(Number.isFinite);
  const medianResidual = median(finite);
  const deviations = finite.map((r) => Math.abs(r - medianResidual));
  const mad = median(deviations);
  if (mad > 1e-12) {
    return { medianResidual, mad, sigma: 1.4826 * mad, method: 'MAD' };
  }
  const variance = finite.reduce((sum, r) => sum + (r - medianResidual) ** 2, 0) / Math.max(1, finite.length);
  return { medianResidual, mad: 0, sigma: Math.sqrt(variance), method: 'SD-fallback' };
}

function intervalWeight(pair, config) {
  if (config.weighting !== 'interval') return 1;
  const span = Math.max(1, pair.monthSpan || 1);
  const a = Math.max(0, Number(config.weightA) || 0);
  const b = Math.max(0, Number(config.weightB) || 0);
  const denominator = a + b * span;
  if (!(denominator > 0)) return 1;
  return 1 / denominator;
}

function fitComponent(component, componentPairs, monthCount, config, requestedBaseIndex, options = {}) {
  const matrixAnchor = component.months[0];
  const parameterMonths = component.months.filter((m) => m !== matrixAnchor);
  const gammaColumn = parameterMonths.length;
  const includeGamma = options.includeGamma === true;
  const columnCount = parameterMonths.length + (includeGamma ? 1 : 0);

  const X = [];
  const y = [];
  const weights = [];
  const clusters = [];
  for (const pair of componentPairs) {
    const row = parameterMonths.map(
      (m) => (pair.monthToIndex === m ? 1 : 0) + (pair.monthFromIndex === m ? -1 : 0),
    );
    if (includeGamma) row.push(pair.renovationMeasure || 0);
    X.push(row);
    const alpha = Number.isFinite(options.alpha) ? options.alpha : 0;
    y.push(pair.logRatio - alpha * (pair.renovationMeasure || 0));
    weights.push(pair.fitWeight ?? pair.baseWeight ?? 1);
    clusters.push(pair.clusterId || pair.propertyId);
  }

  let fit;
  let refitWithoutGamma = false;
  try {
    fit = fitWLS(X, y, weights, clusters, { covariance: config.clusterSE ? 'cluster' : 'model' });
    if (includeGamma && fit.aliasedColumns.includes(gammaColumn)) {
      refitWithoutGamma = true;
      const reduced = fitComponent(
        component,
        componentPairs,
        monthCount,
        config,
        requestedBaseIndex,
        { ...options, includeGamma: false, alpha: options.alpha },
      );
      return {
        ...reduced,
        renovationTermAliased: true,
        warnings: [
          ...(reduced.warnings ?? []),
          {
            code: 'reno_term_aliased',
            message: `组件 ${component.id} 中翻修变量与月份效应共线，已改为不估计独立翻修系数`,
          },
        ],
      };
    }
  } catch (error) {
    return {
      id: component.id,
      ok: false,
      months: component.months,
      message: error.message,
      warnings: [{ code: 'component_solve_failed', message: error.message }],
      pairFits: new Map(),
      monthly: [],
    };
  }

  const covariancePivot =
    config.clusterSE && fit.clusterReliable ? fit.clusterCovPivot : fit.modelCovPivot ?? fit.clusterCovPivot;
  const covarianceType = config.clusterSE && fit.clusterReliable ? 'cluster' : 'model';

  // Full component month covariance. The matrix anchor is constrained to zero.
  const mCount = component.months.length;
  const monthCov = Array.from({ length: mCount }, () => new Array(mCount).fill(0));
  const betaComponent = new Array(mCount).fill(0);
  component.months.forEach((monthIndex, localIndex) => {
    if (monthIndex === matrixAnchor) return;
    const fullColumn = parameterMonths.indexOf(monthIndex);
    const pivotIndex = fit.pivotColumns.indexOf(fullColumn);
    betaComponent[localIndex] = pivotIndex >= 0 ? fit.beta[fullColumn] : 0;
    if (pivotIndex >= 0 && covariancePivot) {
      for (let localOther = 0; localOther < mCount; localOther += 1) {
        const otherMonth = component.months[localOther];
        if (otherMonth === matrixAnchor) continue;
        const otherFullColumn = parameterMonths.indexOf(otherMonth);
        const otherPivot = fit.pivotColumns.indexOf(otherFullColumn);
        if (otherPivot >= 0) monthCov[localIndex][localOther] = covariancePivot[pivotIndex][otherPivot];
      }
    }
  });

  let referenceLocal = 0;
  if (Number.isInteger(requestedBaseIndex) && component.months.includes(requestedBaseIndex)) {
    referenceLocal = component.months.indexOf(requestedBaseIndex);
  }
  const z = zForConfidence(config.confidence);
  const monthly = component.months.map((monthIndex, localIndex) => {
    const logIndex = betaComponent[localIndex] - betaComponent[referenceLocal];
    const variance =
      monthCov[localIndex][localIndex] +
      monthCov[referenceLocal][referenceLocal] -
      2 * monthCov[localIndex][referenceLocal];
    const seLog = Math.sqrt(Math.max(0, variance));
    return {
      monthIndex,
      componentId: component.id,
      referenceMonthIndex: component.months[referenceLocal],
      logIndex,
      index: 100 * Math.exp(logIndex),
      seLog,
      ciLogLow: logIndex - z * seLog,
      ciLogHigh: logIndex + z * seLog,
      ciLow: 100 * Math.exp(logIndex - z * seLog),
      ciHigh: 100 * Math.exp(logIndex + z * seLog),
    };
  });

  const pairFits = new Map();
  componentPairs.forEach((pair, i) => {
    pairFits.set(pair.id, {
      componentId: component.id,
      residual: fit.residuals[i],
      fitted: fit.fitted[i],
      weight: weights[i],
      cluster: clusters[i],
    });
  });

  const gamma = includeGamma && !refitWithoutGamma ? fit.beta[gammaColumn] : null;
  const gammaSe = includeGamma && !refitWithoutGamma ? fit.se[gammaColumn] : null;

  return {
    id: component.id,
    ok: true,
    months: component.months,
    matrixAnchor,
    referenceMonth: component.months[referenceLocal],
    pairCount: componentPairs.length,
    propertyCount: new Set(componentPairs.map((p) => p.propertyId)).size,
    clusterCount: fit.clusterCount,
    clusterReliable: fit.clusterReliable,
    covarianceType,
    rank: fit.rank,
    designColumns: columnCount,
    aliasedColumns: fit.aliasedColumns,
    gamma,
    gammaSe,
    gammaInterpretation:
      gamma == null
        ? null
        : 'y = 月份效应 + γ × 翻修成本/前次价格；γ≈1 表示翻修支出近乎全额资本化',
    monthly,
    pairFits,
    warnings: [],
  };
}

function fitStage(pairs, monthCount, config, requestedBaseIndex, options = {}) {
  const crossMonthPairs = pairs.filter((p) => p.monthFromIndex !== p.monthToIndex);
  const edges = crossMonthPairs.map((p) => ({ from: p.monthFromIndex, to: p.monthToIndex, pairId: p.id }));
  const graph = buildMonthComponents(monthCount, edges);
  const monthly = new Array(monthCount).fill(null);
  const components = [];
  const pairFits = new Map();
  const warnings = [];

  for (const component of graph.components) {
    if (component.months.length < 2) continue;
    const componentPairs = crossMonthPairs.filter(
      (p) =>
        component.months.includes(p.monthFromIndex) &&
        component.months.includes(p.monthToIndex),
    );
    if (!componentPairs.length) continue;
    const result = fitComponent(
      component,
      componentPairs,
      monthCount,
      config,
      requestedBaseIndex,
      options,
    );
    components.push(result);
    for (const m of result.monthly ?? []) monthly[m.monthIndex] = m;
    for (const [id, info] of result.pairFits ?? []) pairFits.set(id, info);
    warnings.push(...(result.warnings ?? []));
  }

  return { graph, components, monthly, pairFits, warnings };
}

function applyRuleStatus(pair, config) {
  const exclusionReasons = [...(pair.baseExclusionReasons ?? [])];
  let renovationTreatment = 'not_present';
  if (pair.renovationIds?.length) {
    if (config.renovationPolicy === 'exclude') {
      exclusionReasons.push('renovation_holding_period');
      renovationTreatment = 'excluded';
    } else if (config.renovationPolicy === 'independent') {
      renovationTreatment = 'independent_term';
    } else if (config.renovationPolicy === 'sensitivity') {
      renovationTreatment = 'sensitivity_adjusted';
    } else {
      renovationTreatment = 'ignored';
    }
  }
  return {
    ...pair,
    exclusionReasons: [...new Set(exclusionReasons)],
    ruleExcluded: exclusionReasons.length > 0,
    renovationTreatment,
  };
}

function summarizeSensitivityFit(stage, monthLabels) {
  return {
    components: stage.components.map((c) => ({
      id: c.id,
      months: c.months,
      referenceMonth: c.referenceMonth,
      gamma: c.gamma,
      monthly: c.monthly.map((m) => ({
        ...m,
        month: monthLabels[m.monthIndex],
      })),
    })),
    monthly: stage.monthly.map((m) => (m ? { ...m, month: monthLabels[m.monthIndex] } : null)),
  };
}

export function analyzeRepeatSales(rawDataset, overrides = {}) {
  const started =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Number(Date.now());
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const normalized = normalizeDataset(rawDataset);
  const diagnostics = [...normalized.warnings];

  if (!normalized.data) {
    return {
      ok: false,
      errors: normalized.errors,
      diagnostics: normalized.errors,
      config,
      pairs: [],
      monthly: [],
      components: [],
    };
  }

  const data = normalized.data;
  const validTransactions = data.transactions.filter((t) => t.valid);
  if (validTransactions.length < 2) {
    return {
      ok: false,
      errors: normalized.errors,
      diagnostics: [
        ...normalized.errors,
        { code: 'not_enough_transactions', message: '有效成交不足两条，无法构造重复成交配对' },
      ],
      dataErrors: normalized.errors,
      config,
      pairs: [],
      monthly: [],
      components: [],
    };
  }

  const monthKeys = validTransactions.map((t) => monthKeyFromDate(t.date)).sort();
  const firstMonth = monthKeys[0];
  const lastMonth = monthKeys[monthKeys.length - 1];
  const monthLabels = enumerateMonths(firstMonth, lastMonth);
  const monthIndexByKey = new Map(monthLabels.map((m, i) => [m, i]));
  const requestedBaseIndex = config.baseMonth ? monthIndexByKey.get(config.baseMonth) ?? null : null;
  if (config.baseMonth && requestedBaseIndex == null) {
    diagnostics.push({ code: 'unknown_base_month', message: `基准月份 ${config.baseMonth} 不在数据月份范围内` });
  }

  const rawPairs = buildPairCandidates(data, config).map((pair) => ({
    ...pair,
    monthFromIndex: monthIndexByKey.get(pair.monthFrom) ?? null,
    monthToIndex: monthIndexByKey.get(pair.monthTo) ?? null,
    baseWeight: intervalWeight(pair, config),
    fitWeight: pair.baseWeight,
  }));

  let decidedPairs = rawPairs.map((p) => applyRuleStatus(p, config));
  let modelPairs = decidedPairs.filter((p) => !p.ruleExcluded);

  if (!modelPairs.some((p) => !p.sameMonth)) {
    const result = {
      ok: false,
      code: 'no_identifying_pairs',
      errors: [
        {
          code: 'no_identifying_pairs',
          message: '所有候选配对都被结构变更、同日/同月或翻修规则排除，没有跨月配对可估计指数',
        },
      ],
      diagnostics,
      dataErrors: normalized.errors,
      config,
      monthLabels,
      pairs: decidedPairs,
      monthly: monthLabels.map((month, monthIndex) => ({ month, monthIndex, estimable: false })),
      components: [],
      counts: buildCounts(decidedPairs, validTransactions, data),
      elapsedMs: elapsed(started),
    };
    return result;
  }

  const alphaMain =
    config.renovationPolicy === 'sensitivity'
      ? (Number(config.sensitivityRecoveryLow) + Number(config.sensitivityRecoveryHigh)) / 2
      : Number(config.renoAlpha ?? 0);
  const includeGamma = config.renovationPolicy === 'independent';

  const initialStage = fitStage(modelPairs, monthLabels.length, config, requestedBaseIndex, {
    alpha: alphaMain,
    includeGamma,
  });
  for (const pair of decidedPairs) {
    const info = initialStage.pairFits.get(pair.id);
    if (info) {
      pair.residual = info.residual;
      pair.fitted = info.fitted;
      pair.componentId = info.componentId;
      pair.modelWeight = info.weight;
    }
  }

  const modeledForResiduals = decidedPairs.filter((p) => Number.isFinite(p.residual));
  const scaleStats = robustResidualScale(modeledForResiduals.map((p) => p.residual));
  for (const pair of decidedPairs) {
    if (!Number.isFinite(pair.residual)) continue;
    const standardized =
      scaleStats.sigma > 1e-12 ? (pair.residual - scaleStats.medianResidual) / scaleStats.sigma : 0;
    pair.standardizedResidual = standardized;
    pair.robustZ = standardized; // sigma = 1.4826 MAD, equivalent to modified z.
    pair.outlier =
      Math.abs(pair.robustZ) > Number(config.outlierThreshold) ||
      Math.abs(pair.residual - scaleStats.medianResidual) > Number(config.outlierAbsoluteLog);
    if (config.outlierPolicy === 'huber') {
      const u = Math.max(1e-12, Math.abs(pair.robustZ));
      pair.huberWeight = u <= config.huberC ? 1 : config.huberC / u;
      pair.downweighted = pair.huberWeight < 0.999;
    } else {
      pair.huberWeight = 1;
      pair.downweighted = false;
    }
  }

  const outlierExcludedIds = new Set();
  const decidedById = new Map(decidedPairs.map((p) => [p.id, p]));
  let finalPairs = [];
  for (const pair of modelPairs) {
    const latest = decidedById.get(pair.id);
    if (config.outlierPolicy === 'exclude' && latest?.outlier) {
      outlierExcludedIds.add(pair.id);
      continue;
    }
    const huberWeight = config.outlierPolicy === 'huber' ? latest.huberWeight ?? 1 : 1;
    finalPairs.push({ ...pair, fitWeight: pair.baseWeight * huberWeight });
  }
  const finalById = new Map(finalPairs.map((p) => [p.id, p]));

  for (const pair of decidedPairs) {
    if (outlierExcludedIds.has(pair.id)) {
      pair.exclusionReasons = [...new Set([...pair.exclusionReasons, 'outlier'])];
    }
    const finalPair = finalById.get(pair.id);
    pair.used = !!finalPair;
    if (finalPair) pair.fitWeight = finalPair.fitWeight;
  }

  const finalStage = fitStage(finalPairs, monthLabels.length, config, requestedBaseIndex, {
    alpha: alphaMain,
    includeGamma,
  });

  let sensitivity = null;
  if (config.renovationPolicy === 'sensitivity') {
    const upperStage = fitStage(finalPairs, monthLabels.length, config, requestedBaseIndex, {
      alpha: Number(config.sensitivityRecoveryLow),
      includeGamma: false,
    });
    const lowerStage = fitStage(finalPairs, monthLabels.length, config, requestedBaseIndex, {
      alpha: Number(config.sensitivityRecoveryHigh),
      includeGamma: false,
    });
    sensitivity = {
      recoveryLow: config.sensitivityRecoveryLow,
      recoveryHigh: config.sensitivityRecoveryHigh,
      interpretation:
        'α 是翻修成本被市场价值承认的比例；α=0 不扣减（指数上界），α=1 按成本/前价全额扣减（指数下界）',
      upper: summarizeSensitivityFit(upperStage, monthLabels),
      lower: summarizeSensitivityFit(lowerStage, monthLabels),
    };
  }

  const monthly = monthLabels.map((month, monthIndex) => {
    const estimate = finalStage.monthly[monthIndex];
    const incident = decidedPairs.filter(
      (p) => p.used && (p.monthFromIndex === monthIndex || p.monthToIndex === monthIndex),
    );
    const propertyIds = new Set(incident.map((p) => p.propertyId));
    if (!estimate) {
      return {
        month,
        monthIndex,
        estimable: false,
        pairCount: incident.length,
        propertyCount: propertyIds.size,
        contributionPairIds: incident.map((p) => p.id),
      };
    }
    return {
      month,
      monthIndex,
      estimable: true,
      pairCount: incident.length,
      propertyCount: propertyIds.size,
      contributionPairIds: incident.map((p) => p.id),
      ...estimate,
    };
  });

  const graph = {
    ...finalStage.graph,
    monthCount: monthLabels.length,
    edges: finalStage.graph.components
      ? finalPairs.map((p) => ({
          pairId: p.id,
          propertyId: p.propertyId,
          from: p.monthFromIndex,
          to: p.monthToIndex,
          used: true,
          outlier: p.outlier,
        }))
      : [],
  };

  const counts = buildCounts(decidedPairs, validTransactions, data, finalPairs);
  collectDiagnostics({ diagnostics, config, graph, finalStage, decidedPairs, scaleStats, normalized });

  return {
    ok: true,
    schemaVersion: 'repeat-sales-lab/1',
    config,
    generatedAt: new Date().toISOString(),
    elapsedMs: elapsed(started),
    meta: data.meta ?? {},
    monthLabels,
    baseMonth: requestedBaseIndex != null ? monthLabels[requestedBaseIndex] : 'component-anchor',
    counts,
    pairs: decidedPairs.map(serializePair),
    monthly,
    components: finalStage.components.map((c) => ({
      ...c,
      monthLabels: c.months.map((i) => monthLabels[i]),
      monthly: c.monthly.map((m) => ({ ...m, month: monthLabels[m.monthIndex] })),
      pairFits: undefined,
    })),
    graph: {
      ...graph,
      monthLabels,
      components: graph.components.map((c) => ({ ...c, monthLabels: c.months.map((i) => monthLabels[i]) })),
    },
    sensitivity,
    diagnostics,
    dataErrors: normalized.errors,
    dataWarnings: normalized.warnings,
    outlierScale: scaleStats,
  };
}

function elapsed(started) {
  const now =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Number(Date.now());
  return Math.max(0, now - started);
}

function buildCounts(pairs, validTransactions, data, finalPairs = []) {
  const used = pairs.filter((p) => p.used);
  return {
    transactions: data.transactions?.length ?? 0,
    validTransactions: validTransactions.length,
    invalidTransactions: (data.transactions?.length ?? 0) - validTransactions.length,
    renovations: data.renovations?.length ?? 0,
    structureEvents: data.structureEvents?.length ?? 0,
    candidatePairs: pairs.length,
    usedPairs: used.length || finalPairs.length,
    sameDayPairs: pairs.filter((p) => p.sameDay).length,
    sameMonthPairs: pairs.filter((p) => p.sameMonth).length,
    structureBarriers: pairs.filter((p) => p.barrierEventIds?.length).length,
    renovationPairs: pairs.filter((p) => p.renovationIds?.length).length,
    renovationExcluded: pairs.filter((p) => p.exclusionReasons?.includes('renovation_holding_period')).length,
    erroneousLinks: pairs.filter((p) => p.crossEntity).length,
    outliers: pairs.filter((p) => p.outlier).length,
    excludedOutliers: pairs.filter((p) => p.exclusionReasons?.includes('outlier')).length,
    properties: new Set(validTransactions.map((t) => t.propertyId)).size,
  };
}

function collectDiagnostics({ diagnostics, config, graph, finalStage, decidedPairs, scaleStats, normalized }) {
  if (normalized.errors.length) {
    diagnostics.push({
      code: 'invalid_records',
      level: 'warning',
      message: `${normalized.errors.length} 条记录未通过校验，已从有效成交/翻修中剔除`,
    });
  }
  const estimableComponents = graph.components.filter((c) => c.months.length > 1);
  const isolated = graph.components.filter((c) => c.months.length === 1);
  if (estimableComponents.length > 1) {
    diagnostics.push({
      code: 'disconnected_months',
      level: 'serious',
      message: `月份图分成 ${estimableComponents.length} 个可估计连通段和 ${isolated.length} 个孤立月；段间水平差不可识别，图表不会连接它们`,
      componentIds: estimableComponents.map((c) => c.id),
    });
  } else if (isolated.length) {
    diagnostics.push({
      code: 'isolated_months',
      level: 'warning',
      message: `${isolated.length} 个日历月没有足够配对连接，已保留缺口而不是插值`,
    });
  }
  diagnostics.push({
    code: 'design_rank',
    level: graph.nullity > estimableComponents.length ? 'serious' : 'info',
    message: `设计矩阵：${graph.monthCount} 个月份列，秩 ${graph.rank}，零空间维数 ${graph.nullity}（每个连通段有一个基准水平自由量）`,
  });
  if (config.clusterSE) {
    const unreliable = finalStage.components.filter((c) => !c.clusterReliable);
    if (unreliable.length) {
      diagnostics.push({
        code: 'cluster_se_unreliable',
        level: 'warning',
        message: `组件 ${unreliable.map((c) => c.id).join(', ')} 只有一个房屋簇，同屋多对相关的聚类稳健区间不可靠，已回退到模型方差`,
      });
    } else {
      diagnostics.push({
        code: 'cluster_correlation',
        level: 'info',
        message: '同一房屋的多对成交按 propertyId 聚类，区间使用聚类稳健三明治协方差',
      });
    }
  }
  if (scaleStats.mad === 0) {
    diagnostics.push({
      code: 'mad_zero',
      level: 'info',
      message: '残差 MAD 为 0，异常检测回退到标准差尺度并同时使用对数残差绝对阈值',
    });
  }
  const badLinks = decidedPairs.filter((p) => p.crossEntity);
  if (badLinks.length) {
    diagnostics.push({
      code: 'erroneous_merge_sample',
      level: config.blockErroneousMerges ? 'warning' : 'critical',
      message: config.blockErroneousMerges
        ? `已拦截 ${badLinks.length} 个由错误实体合并产生的跨房屋配对`
        : `正在演示错误实体合并：${badLinks.length} 个跨房屋配对被放行，结果不得作为正式指数`,
      pairIds: badLinks.map((p) => p.id),
    });
  }
  for (const warning of finalStage.warnings) diagnostics.push(warning);
  for (const component of finalStage.components ?? []) {
    if (Number.isFinite(component.gamma)) {
      const z = zForConfidence(config.confidence);
      diagnostics.push({
        code: 'renovation_gamma',
        level: 'info',
        message: `连通段 ${component.id} 的独立翻修项 γ=${component.gamma.toFixed(3)}（SE=${component.gammaSe?.toFixed(3) ?? '—'}，${Math.round(config.confidence * 100)}% CI [${(component.gamma - z * component.gammaSe).toFixed(3)}, ${(component.gamma + z * component.gammaSe).toFixed(3)}]）。${component.gammaInterpretation}`,
      });
    }
  }
}

function serializePair(pair) {
  // Maps are already detached; this function also ensures no accidental raw
  // dataset object or non-serializable value reaches a worker message.
  return {
    ...pair,
    raw: undefined,
  };
}
