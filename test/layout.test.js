import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOM_EPOCH_MS,
  MAX_SIGNED_ID,
  encodeId,
  layoutMetadata,
  parseId,
} from '../src/layout.js';

test('layout round-trips every declared field', () => {
  const id = encodeId({
    timestampMs: CUSTOM_EPOCH_MS + 123_456,
    datacenterId: 17,
    workerId: 23,
    sequence: 4095,
  });
  assert.deepEqual(parseId(id), {
    id: id.toString(),
    layoutVersion: 'snowflake-41-5-5-12-v1',
    timestampMs: CUSTOM_EPOCH_MS + 123_456,
    timestampIso: new Date(CUSTOM_EPOCH_MS + 123_456).toISOString(),
    datacenterId: 17,
    workerId: 23,
    sequence: 4095,
  });
});

test('numeric order follows timestamp then topology fields then sequence', () => {
  const values = [
    { timestampMs: CUSTOM_EPOCH_MS, datacenterId: 0, workerId: 0, sequence: 0 },
    { timestampMs: CUSTOM_EPOCH_MS, datacenterId: 0, workerId: 0, sequence: 1 },
    { timestampMs: CUSTOM_EPOCH_MS, datacenterId: 0, workerId: 1, sequence: 0 },
    { timestampMs: CUSTOM_EPOCH_MS + 1, datacenterId: 0, workerId: 0, sequence: 0 },
  ].map(encodeId);
  for (let index = 1; index < values.length; index += 1) assert.ok(values[index] > values[index - 1]);
});

test('layout stays inside signed-positive 63 bits and declares its horizon', () => {
  const metadata = layoutMetadata();
  const maximum = encodeId({
    timestampMs: metadata.finalTimestampMs,
    datacenterId: 31,
    workerId: 31,
    sequence: 4095,
  });
  assert.equal(maximum, MAX_SIGNED_ID);
  assert.equal(parseId(maximum).timestampIso, metadata.finalTimestampIso);
});

test('layout rejects invalid fields and noncanonical decimal text', () => {
  assert.throws(() => encodeId({
    timestampMs: CUSTOM_EPOCH_MS - 1, datacenterId: 0, workerId: 0, sequence: 0,
  }), /outside/);
  assert.throws(() => encodeId({
    timestampMs: CUSTOM_EPOCH_MS, datacenterId: 32, workerId: 0, sequence: 0,
  }), /datacenterId/);
  assert.throws(() => parseId('001'), /canonical/);
  assert.throws(() => parseId((MAX_SIGNED_ID + 1n).toString()), /outside/);
});
