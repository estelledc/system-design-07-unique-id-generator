import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ManualClock } from '../src/clock.js';
import { RequestConflictError } from '../src/errors.js';
import { CUSTOM_EPOCH_MS } from '../src/layout.js';
import { openIdService } from '../src/service.js';

async function fixture(directory = null) {
  const stateDirectory = directory ?? await mkdtemp(join(tmpdir(), 'fenced-id-service-'));
  return openIdService({
    stateDirectory,
    datacenterId: 2,
    workerId: 4,
    clock: new ManualClock(CUSTOM_EPOCH_MS + 40_000),
  });
}

test('allocation retries return the same durable IDs and count changes conflict', async () => {
  const { service, state } = await fixture();
  const first = await service.allocate({ requestId: 'request-one', count: 3 });
  assert.equal(first.replayed, false);
  const retry = await service.allocate({ requestId: 'request-one', count: 3 });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.ids, first.ids);
  await assert.rejects(
    service.allocate({ requestId: 'request-one', count: 2 }),
    RequestConflictError,
  );
  await state.close();
});

test('concurrent duplicate requests converge on one allocation', async () => {
  const { service, state } = await fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => (
    service.allocate({ requestId: 'same-request', count: 10 })
  )));
  for (const result of results) assert.deepEqual(result.ids, results[0].ids);
  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  await state.close();
});

test('request allocation and decode survive graceful reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fenced-id-service-reopen-'));
  const first = await fixture(directory);
  const allocated = await first.service.allocate({ requestId: 'persistent-request', count: 2 });
  const decoded = first.service.decode(allocated.ids[0]);
  assert.equal(decoded.datacenterId, 2);
  assert.equal(decoded.workerId, 4);
  await first.state.close();

  const second = await fixture(directory);
  const replayed = await second.service.allocate({ requestId: 'persistent-request', count: 2 });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.ids, allocated.ids);
  await second.state.close();
});

test('reusing a state directory with another worker identity fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fenced-id-service-identity-'));
  const first = await fixture(directory);
  await first.service.allocate({ requestId: 'identity-anchor', count: 1 });
  await first.state.close();

  await assert.rejects(openIdService({
    stateDirectory: directory,
    datacenterId: 2,
    workerId: 5,
    clock: new ManualClock(CUSTOM_EPOCH_MS + 40_000),
  }), /already bound to another generator identity/);

  const reopened = await fixture(directory);
  await reopened.state.close();
});

test('identical worker configuration in different state directories can collide', async () => {
  const left = await fixture();
  const right = await fixture();
  const leftId = (await left.service.allocate({ requestId: 'left-request', count: 1 })).ids[0];
  const rightId = (await right.service.allocate({ requestId: 'right-request', count: 1 })).ids[0];
  assert.equal(leftId, rightId);
  await left.state.close();
  await right.state.close();
});
