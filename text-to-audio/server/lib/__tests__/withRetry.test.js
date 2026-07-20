'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../withRetry');

test('resolves immediately when fn succeeds on the first try', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries after a failure and succeeds once fn recovers', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'recovered';
    },
    { retries: 3, baseDelayMs: 1 }
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('gives up and throws the last error after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { retries: 2, baseDelayMs: 1 }
      ),
    /fail-3/
  );
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});
