import { analyzeRepeatSales } from './repeatSales.js';
import { fitWLS } from './linalg.js';
import { SAMPLES } from './samples.js';

function closeTo(actual, expected, tolerance = 1e-8) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function check(id, name, actual, expected, pass, details = '') {
  return { id, name, actual, expected, pass: !!pass, details };
}

export function runSelfChecks() {
  const checks = [];

  // Exact weighted/cluster-sandwich example derived in README.
  const fit = fitWLS(
    [[1], [1]],
    [0.1, 0.2],
    [1, 0.5],
    ['H1', 'H2'],
    { covariance: 'cluster' },
  );
  const expectedBeta = 2 / 15;
  const expectedSe = 2 / 45;
  checks.push(
    check(
      'weighted-beta-exact',
      'WLS：w=[1,1/2]，y=[0.1,0.2] → β=2/15',
      fit.beta[0],
      expectedBeta,
      closeTo(fit.beta[0], expectedBeta, 1e-12),
      'β=(0.1+0.5×0.2)/(1+0.5)',
    ),
  );
  checks.push(
    check(
      'cluster-se-exact',
      '两簇聚类稳健 95% 区间标准误 = 2/45',
      fit.se[0],
      expectedSe,
      closeTo(fit.se[0], expectedSe, 1e-10),
      'c=2；V=2×[(−1/30)^2+(1/30)^2]/(3/2)^2=4/2025',
    ),
  );

  const tiny = {
    transactions: [
      { id: 'a1', propertyId: 'A', date: '2024-01-10', price: 100000 },
      { id: 'a2', propertyId: 'A', date: '2024-02-10', price: 108000 },
      { id: 'b1', propertyId: 'B', date: '2024-01-11', price: 100000 },
      { id: 'b2', propertyId: 'B', date: '2024-02-11', price: 110000 },
      { id: 'c1', propertyId: 'C', date: '2024-01-12', price: 100000 },
      { id: 'c2', propertyId: 'C', date: '2024-02-12', price: 112000 },
    ],
  };
  const result = analyzeRepeatSales(tiny, { outlierPolicy: 'keep', clusterSE: true });
  const expectedFebruaryIndex = 100 * Math.cbrt(1.08 * 1.1 * 1.12);
  const jan = result.monthly.find((m) => m.month === '2024-01');
  const feb = result.monthly.find((m) => m.month === '2024-02');
  checks.push(
    check(
      'base-normalization-100',
      '基准月归一化：2024-01 = 100',
      jan?.index,
      100,
      result.ok && closeTo(jan?.index, 100, 1e-10),
      '丢弃基准月虚拟变量列，β_base=0，指数=100e^β',
    ),
  );
  checks.push(
    check(
      'geometric-mean-index',
      '二月指数等于三个价比的几何平均×100',
      feb?.index,
      expectedFebruaryIndex,
      result.ok && closeTo(feb?.index, expectedFebruaryIndex, 1e-8),
      `(1.08×1.10×1.12)^(1/3)×100`,
    ),
  );
  checks.push(
    check(
      'ci-present',
      '区间存在且下界 < 点估计 < 上界',
      feb ? [feb.ciLow, feb.index, feb.ciHigh] : null,
      null,
      result.ok && feb.ciLow < feb.index && feb.index < feb.ciHigh,
      'Wald 95%，聚类稳健协方差；三所独立房屋时与经典 OLS 方差相同（含小样本修正）',
    ),
  );

  const weighted = analyzeRepeatSales(SAMPLES.handcheck, {
    weighting: 'interval',
    weightA: 0,
    weightB: 1,
    outlierPolicy: 'keep',
  });
  const w1 = weighted.pairs.find((p) => p.id === 'HW1#P1');
  const w2 = weighted.pairs.find((p) => p.id === 'HW2#P1');
  checks.push(
    check(
      'interval-weights',
      '间隔权重：1 个月=1，2 个月=1/2',
      w1 && w2 ? [w1.baseWeight, w2.baseWeight] : null,
      [1, 0.5],
      closeTo(w1?.baseWeight, 1, 1e-12) && closeTo(w2?.baseWeight, 0.5, 1e-12),
      'w=1/(A+B×月份跨度)，本例 A=0,B=1',
    ),
  );

  const disconnected = analyzeRepeatSales(SAMPLES.disconnected, { outlierPolicy: 'keep' });
  checks.push(
    check(
      'rank-and-disconnection',
      '断开样本：8 月列、秩 4、两个可估计段',
      disconnected.ok
        ? { rank: disconnected.graph.rank, months: disconnected.monthLabels.length, estimable: disconnected.graph.components.filter((c) => c.months.length > 1).length }
        : disconnected.errors,
      { rank: 4, months: 8, estimable: 2 },
      disconnected.ok &&
        disconnected.graph.rank === 4 &&
        disconnected.monthLabels.length === 8 &&
        disconnected.graph.components.filter((c) => c.months.length > 1).length === 2,
      '4 个连通组：1–3 月、4 月、5 月、6–8 月；不能跨段确定水平',
    ),
  );

  const sameDay = analyzeRepeatSales(SAMPLES.sameDay, { outlierPolicy: 'keep' });
  const sameDayPair = sameDay.pairs.find((p) => p.id === 'SD1#P1');
  checks.push(
    check(
      'same-day-not-identifying',
      '同日成交被标记且不进入月份回归',
      sameDayPair ? { sameDay: sameDayPair.sameDay, used: sameDayPair.used, reasons: sameDayPair.exclusionReasons } : null,
      { sameDay: true, used: false, reasons: ['same_day'] },
      sameDayPair?.sameDay && !sameDayPair.used && sameDayPair.exclusionReasons.includes('same_day'),
      '同一月份设计行的 -1/+1 落在同一列并抵消',
    ),
  );

  const badMergeBlocked = analyzeRepeatSales(SAMPLES.badMerge, { blockErroneousMerges: true });
  const blockedPair = badMergeBlocked.pairs.find((p) => p.identityLinkId === 'BAD-ENTITY-78');
  checks.push(
    check(
      'bad-merge-blocked',
      '错误实体合并产生的跨房屋配对默认拦截',
      blockedPair ? { crossEntity: blockedPair.crossEntity, used: blockedPair.used } : null,
      { crossEntity: true, used: false },
      blockedPair?.crossEntity && !blockedPair.used && blockedPair.exclusionReasons.includes('erroneous_entity_merge'),
      '放行该规则会把 H7→H8 的 100→260 当成重复成交',
    ),
  );

  return {
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
    checks,
  };
}
