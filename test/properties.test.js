import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_EPOCH_MS, encodeId, parseId } from '../src/layout.js';

test('all 1024 topology identities occupy distinct bits at one time and sequence', () => {
  const ids = new Set();
  for (let datacenterId = 0; datacenterId < 32; datacenterId += 1) {
    for (let workerId = 0; workerId < 32; workerId += 1) {
      ids.add(encodeId({
        timestampMs: CUSTOM_EPOCH_MS + 1,
        datacenterId,
        workerId,
        sequence: 0,
      }).toString());
    }
  }
  assert.equal(ids.size, 1024);
});

test('deterministic field corpus round-trips without bit overlap', () => {
  for (let index = 0; index < 10_000; index += 1) {
    const fields = {
      timestampMs: CUSTOM_EPOCH_MS + ((index * 7919) % 1_000_000),
      datacenterId: (index * 7) % 32,
      workerId: (index * 13) % 32,
      sequence: (index * 2017) % 4096,
    };
    const decoded = parseId(encodeId(fields));
    assert.equal(decoded.timestampMs, fields.timestampMs);
    assert.equal(decoded.datacenterId, fields.datacenterId);
    assert.equal(decoded.workerId, fields.workerId);
    assert.equal(decoded.sequence, fields.sequence);
  }
});
