'use strict';

/**
 * Runs an async function, retrying on failure with exponential backoff.
 * Used to smooth over transient Piper child-process failures (e.g. a
 * momentarily busy CPU) without failing an entire multi-hundred-chunk job
 * because of one flaky invocation.
 *
 * @param {() => Promise<any>} fn
 * @param {{retries?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<any>}
 */
async function withRetry(fn, options = {}) {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 300;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry };
