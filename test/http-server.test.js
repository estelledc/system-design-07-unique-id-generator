import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ManualClock } from '../src/clock.js';
import { createHttpService } from '../src/http-server.js';
import { CUSTOM_EPOCH_MS } from '../src/layout.js';
import { openIdService } from '../src/service.js';

async function fixture(t) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'fenced-id-http-'));
  const { service, state } = await openIdService({
    stateDirectory,
    datacenterId: 5,
    workerId: 9,
    clock: new ManualClock(CUSTOM_EPOCH_MS + 50_000),
  });
  const logs = [];
  const { server } = createHttpService({
    idService: service,
    state,
    logger: (line) => logs.push(line),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await state.close();
  });
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, logs };
}

async function allocate(baseUrl, requestId, count) {
  const response = await fetch(`${baseUrl}/v1/ids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': requestId },
    body: JSON.stringify({ count }),
  });
  return { status: response.status, body: await response.json() };
}

test('HTTP allocation is durable-idempotent, decodable, and absent from logs', async (t) => {
  const { baseUrl, logs } = await fixture(t);
  const rawRequestId = 'private-request-42';
  const first = await allocate(baseUrl, rawRequestId, 3);
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.equal(new Set(first.body.ids).size, 3);

  const retry = await allocate(baseUrl, rawRequestId, 3);
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.ids, first.body.ids);

  const decodedResponse = await fetch(`${baseUrl}/v1/ids/${first.body.ids[0]}`);
  const decoded = await decodedResponse.json();
  assert.equal(decoded.decoded.datacenterId, 5);
  assert.equal(decoded.decoded.workerId, 9);

  const conflict = await allocate(baseUrl, rawRequestId, 2);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
  const logText = logs.join('\n');
  assert.ok(!logText.includes(rawRequestId));
  for (const id of first.body.ids) assert.ok(!logText.includes(id));
});

test('HTTP validates request identity, count, JSON, and body size', async (t) => {
  const { baseUrl } = await fixture(t);
  const missingIdentity = await fetch(`${baseUrl}/v1/ids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"count":1}',
  });
  assert.equal(missingIdentity.status, 400);

  assert.equal((await allocate(baseUrl, 'valid-request', 1001)).status, 400);
  const malformed = await fetch(`${baseUrl}/v1/ids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'bad-json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${baseUrl}/v1/ids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'large-body' },
    body: JSON.stringify({ count: 1, padding: 'x'.repeat(3000) }),
  });
  assert.equal(oversized.status, 413);
});

test('health and metrics expose configuration without the lock capability', async (t) => {
  const { baseUrl } = await fixture(t);
  const ready = await fetch(`${baseUrl}/health/ready`);
  const text = await ready.text();
  assert.equal(ready.status, 200);
  assert.match(text, /snowflake-41-5-5-12-v1/);
  assert.ok(!text.includes('token'));
  const metrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /fenced_id_allocated_total/);
});
