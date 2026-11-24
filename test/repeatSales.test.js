import test from 'node:test';
import assert from 'node:assert/strict';
import { runSelfChecks } from '../src/core/selfCheck.js';
import { analyzeRepeatSales } from '../src/core/repeatSales.js';
import { generateBatchDataset, SAMPLES } from '../src/core/samples.js';

test('all transparent hand-calculation checks pass', () => {
  const result = runSelfChecks();
  const failures = result.checks.filter((c) => !c.pass);
  assert.equal(result.failed, 0, failures.map((f) => `${f.id}: ${JSON.stringify(f.actual)}`).join('\n'));
});

test('renovation policy changes the exact affected pair set', () => {
  const excluded = analyzeRepeatSales(SAMPLES.renovationSplit, { renovationPolicy: 'exclude' });
  const independent = analyzeRepeatSales(SAMPLES.renovationSplit, { renovationPolicy: 'independent' });
  const id = 'RS2#P1';
  const pExcluded = excluded.pairs.find((p) => p.id === id);
  const pIndependent = independent.pairs.find((p) => p.id === id);
  assert.equal(pExcluded.used, false);
  assert.ok(pExcluded.exclusionReasons.includes('renovation_holding_period'));
  assert.equal(pIndependent.used, true);
  assert.equal(pIndependent.renovationTreatment, 'independent_term');
});

test('split barrier prevents crossing pair from entering index', () => {
  const result = analyzeRepeatSales(SAMPLES.renovationSplit);
  const pair = result.pairs.find((p) => p.id === 'RS3#P1');
  assert.equal(pair.used, false);
  assert.ok(pair.exclusionReasons.includes('structure_barrier'));
  assert.ok(pair.barrierEventIds.includes('SPLIT-RS3'));
});

test('outlier exclusion can split or alter design without mutating other config result', () => {
  const kept = analyzeRepeatSales(SAMPLES.badMerge, {
    blockErroneousMerges: false,
    outlierPolicy: 'keep',
  });
  const removed = analyzeRepeatSales(SAMPLES.badMerge, {
    blockErroneousMerges: false,
    outlierPolicy: 'exclude',
  });
  const badId = kept.pairs.find((p) => p.identityLinkId === 'BAD-ENTITY-78').id;
  assert.equal(kept.pairs.find((p) => p.id === badId).used, true);
  assert.equal(removed.pairs.find((p) => p.id === badId).used, false);
  assert.ok(removed.pairs.find((p) => p.id === badId).exclusionReasons.includes('outlier'));
});

test('batch generator produces a computable scale sample', () => {
  const dataset = generateBatchDataset({ properties: 2500, months: 72, seed: 42 });
  const started = Date.now();
  const result = analyzeRepeatSales(dataset, { outlierPolicy: 'flag' });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true, result.errors);
  assert.ok(result.counts.candidatePairs > 4000);
  assert.ok(result.monthly.filter((m) => m.estimable).length > 40);
  assert.ok(elapsed < 15_000, `analysis took ${elapsed}ms`);
});
