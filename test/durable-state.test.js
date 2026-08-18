import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DurableGeneratorState, recoverStaleLock } from '../src/durable-state.js';
import { LockHeldError, RequestConflictError, StateCorruptionError } from '../src/errors.js';
import { CUSTOM_EPOCH_MS, encodeId } from '../src/layout.js';

async function directory() {
  return mkdtemp(join(tmpdir(), 'fenced-id-state-'));
}

function sampleId(sequence = 0) {
  return encodeId({
    timestampMs: CUSTOM_EPOCH_MS + 1,
    datacenterId: 0,
    workerId: 0,
    sequence,
  }).toString();
}

function bind(state, { datacenterId = 0, workerId = 0 } = {}) {
  return state.bindIdentity({
    layoutVersion: 'snowflake-41-5-5-12-v1',
    customEpochMs: CUSTOM_EPOCH_MS,
    datacenterId,
    workerId,
  });
}

test('state lock excludes a second process owner and graceful close releases it', async () => {
  const path = await directory();
  const first = await DurableGeneratorState.open({ directory: path });
  await assert.rejects(DurableGeneratorState.open({ directory: path }), LockHeldError);
  await first.close();
  const second = await DurableGeneratorState.open({ directory: path });
  await second.close();
});

test('lease and request allocations replay with idempotent identity', async () => {
  const path = await directory();
  const state = await DurableGeneratorState.open({ directory: path });
  await bind(state);
  await state.reserveHighWatermark(CUSTOM_EPOCH_MS + 100);
  assert.deepEqual(await state.recordRequest('request-one', 2, [sampleId(0), sampleId(1)]), {
    applied: true,
    ids: [sampleId(0), sampleId(1)],
  });
  assert.equal((await state.recordRequest('request-one', 2, [sampleId(0), sampleId(1)])).applied, false);
  await assert.rejects(
    state.recordRequest('request-one', 1, [sampleId(0)]),
    RequestConflictError,
  );
  await state.close();

  const reopened = await DurableGeneratorState.open({ directory: path });
  assert.equal(reopened.highWatermark(), CUSTOM_EPOCH_MS + 100);
  assert.deepEqual(reopened.lookupRequest('request-one'), { count: 2, ids: [sampleId(0), sampleId(1)] });
  await reopened.close();
});

test('state permissions are restricted and lease must increase', async () => {
  const path = await directory();
  const walPath = join(path, 'generator.state.wal');
  await writeFile(walPath, '', { mode: 0o644 });
  await chmod(walPath, 0o644);
  const state = await DurableGeneratorState.open({ directory: path });
  await bind(state);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(walPath)).mode & 0o777, 0o600);
  await state.reserveHighWatermark(CUSTOM_EPOCH_MS + 10);
  await assert.rejects(state.reserveHighWatermark(CUSTOM_EPOCH_MS + 10), /increase strictly/);
  await state.close();
});

test('stale lock recovery requires death confirmation and the exact token', async () => {
  const path = await directory();
  await DurableGeneratorState.open({ directory: path });
  const lock = JSON.parse(await readFile(join(path, 'generator.lock'), 'utf8'));
  await assert.rejects(recoverStaleLock({
    directory: path, expectedToken: lock.token, processDeathConfirmed: false,
  }), /must be true/);
  await assert.rejects(recoverStaleLock({
    directory: path, expectedToken: 'wrong-token-that-is-long', processDeathConfirmed: true,
  }), /does not match/);
  const receipt = await recoverStaleLock({
    directory: path, expectedToken: lock.token, processDeathConfirmed: true,
  });
  assert.equal(receipt.recoveredPid, process.pid);
  const reopened = await DurableGeneratorState.open({ directory: path });
  await reopened.close();
});

test('truncated and checksum-corrupt state refuse startup without leaving a lock', async () => {
  const truncated = await directory();
  await appendFile(join(truncated, 'generator.state.wal'), '{"partial":', 'utf8');
  await assert.rejects(DurableGeneratorState.open({ directory: truncated }), StateCorruptionError);
  await assert.rejects(readFile(join(truncated, 'generator.lock'), 'utf8'), { code: 'ENOENT' });

  const corrupt = await directory();
  const state = await DurableGeneratorState.open({ directory: corrupt });
  await bind(state);
  await state.reserveHighWatermark(CUSTOM_EPOCH_MS + 10);
  await state.close();
  const walPath = join(corrupt, 'generator.state.wal');
  const wal = await readFile(walPath, 'utf8');
  await writeFile(walPath, wal.replace(/"checksum":"[a-f0-9]+"/, '"checksum":"bad"'), 'utf8');
  await assert.rejects(DurableGeneratorState.open({ directory: corrupt }), /checksum mismatch/);
});
