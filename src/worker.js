import { analyzeRepeatSales } from './core/repeatSales.js';

self.onmessage = (event) => {
  const message = event.data ?? {};
  const { jobId, slot, nonce, dataset, config } = message;
  try {
    const result = analyzeRepeatSales(dataset, config ?? {});
    self.postMessage({
      type: 'analysis-complete',
      jobId,
      slot,
      nonce,
      ok: true,
      result,
    });
  } catch (error) {
    self.postMessage({
      type: 'analysis-error',
      jobId,
      slot,
      nonce,
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        stack: error?.stack ?? '',
      },
    });
  }
};
