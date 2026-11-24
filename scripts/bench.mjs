import { analyzeRepeatSales } from '../src/core/repeatSales.js';
import { generateBatchDataset } from '../src/core/samples.js';

const sizes = process.argv.slice(2).map(Number).filter(Number.isFinite);
const cases = sizes.length ? sizes : [1000, 10000, 50000];

for (const properties of cases) {
  const dataset = generateBatchDataset({ properties, months: 120, seed: 736 });
  const txCount = dataset.transactions.length;
  const start = performance.now();
  const result = analyzeRepeatSales(dataset, {
    weighting: 'interval',
    outlierPolicy: 'flag',
    clusterSE: true,
  });
  const elapsed = performance.now() - start;
  const used = result.counts.usedPairs;
  const memory = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(
    JSON.stringify({
      properties,
      transactions: txCount,
      candidatePairs: result.counts.candidatePairs,
      usedPairs: used,
      estimableMonths: result.monthly.filter((m) => m.estimable).length,
      components: result.graph.components.filter((c) => c.months.length > 1).length,
      elapsedMs: Number(elapsed.toFixed(1)),
      heapUsedMb: Number(memory.toFixed(1)),
      ok: result.ok,
    }),
  );
  if (!result.ok) {
    console.error(result.errors);
    process.exitCode = 1;
  }
}
