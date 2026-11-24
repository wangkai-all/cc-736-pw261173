import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generateBatchDataset } from '../src/core/samples.js';

const count = Number(process.argv[2] ?? 5000);
const output = resolve(process.argv[3] ?? `samples/batch-${count}.json`);
const dataset = generateBatchDataset({ properties: count, months: 120, seed: 2611736 });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(dataset), 'utf8');
console.log(`Wrote ${dataset.transactions.length} transactions for ${count} properties to ${output}`);
