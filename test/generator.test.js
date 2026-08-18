import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ManualClock } from '../src/clock.js';
import { DurableGeneratorState } from '../src/durable-state.js';
import { ClockAheadOfFenceError, ClockRegressionError } from '../src/errors.js';
import { FencedSnowflakeGenerator } from '../src/generator.js';
import { CUSTOM_EPOCH_MS, parseId } from '../src/layout.js';

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fenced-id-generator-'));
  const state = await DurableGeneratorState.open({ directory });
  const clock = options.clock ?? new ManualClock(CUSTOM_EPOCH_MS + 10_000);
  const generator = new FencedSnowflakeGenerator({
    state,
    clock,
    datacenterId: 3,
    workerId: 7,
    ...options,
  });
  return { clock, directory, generator, state };
}

test('fixed-millisecond sequence exhaustion advances logical time without duplicates', async () => {
  const { generator, state } = await fixture();
  const ids = await generator.generate(4097);
  assert.equal(new Set(ids).size, ids.length);
  const first = parseId(ids[0]);
  const last = parseId(ids.at(-1));
  assert.equal(first.sequence, 0);
  assert.equal(parseId(ids[4095]).sequence, 4095);
  assert.equal(last.sequence, 0);
  assert.equal(last.timestampMs, first.timestampMs + 1);
  for (let index = 1; index < ids.length; index += 1) assert.ok(BigInt(ids[index]) > BigInt(ids[index - 1]));
  await state.close();
});

test('concurrent callers are serialized into one strictly increasing stream', async () => {
  const { generator, state } = await fixture();
  const batches = await Promise.all(Array.from({ length: 20 }, () => generator.generate(500)));
  const ids = batches.flat();
  assert.equal(new Set(ids).size, 10_000);
  const sorted = [...ids].sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
  assert.deepEqual(ids, sorted);
  await state.close();
});

test('clock rollback fails closed by default and can be tolerated only within an explicit bound', async () => {
  const strict = await fixture();
  await strict.generator.generate();
  strict.clock.advance(-1);
  await assert.rejects(strict.generator.generate(), ClockRegressionError);
  await strict.state.close();

  const tolerant = await fixture({ maxClockRollbackMs: 5 });
  const first = await tolerant.generator.generate();
  tolerant.clock.advance(-5);
  const second = await tolerant.generator.generate();
  assert.ok(BigInt(second[0]) > BigInt(first[0]));
  tolerant.clock.advance(-1);
  await assert.rejects(tolerant.generator.generate(), ClockRegressionError);
  await tolerant.state.close();
});

test('restart jumps beyond the prior durable timestamp lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fenced-id-restart-'));
  const clock = new ManualClock(CUSTOM_EPOCH_MS + 20_000);
  const firstState = await DurableGeneratorState.open({ directory });
  const first = new FencedSnowflakeGenerator({
    state: firstState, clock, datacenterId: 1, workerId: 2, leaseDurationMs: 100,
  });
  const firstId = (await first.generate())[0];
  const priorFence = firstState.highWatermark();
  await firstState.close();

  const secondState = await DurableGeneratorState.open({ directory });
  const second = new FencedSnowflakeGenerator({
    state: secondState, clock, datacenterId: 1, workerId: 2, leaseDurationMs: 100,
  });
  const secondId = (await second.generate())[0];
  assert.ok(BigInt(secondId) > BigInt(firstId));
  assert.equal(parseId(secondId).timestampMs, priorFence + 1);
  await secondState.close();
});

test('repeated restart cannot outrun the declared future-drift budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fenced-id-drift-'));
  const clock = new ManualClock(CUSTOM_EPOCH_MS + 30_000);
  const firstState = await DurableGeneratorState.open({ directory });
  const first = new FencedSnowflakeGenerator({
    state: firstState, clock, datacenterId: 0, workerId: 0,
    leaseDurationMs: 100, maxFutureDriftMs: 100,
  });
  await first.generate();
  await firstState.close();

  const secondState = await DurableGeneratorState.open({ directory });
  const second = new FencedSnowflakeGenerator({
    state: secondState, clock, datacenterId: 0, workerId: 0,
    leaseDurationMs: 100, maxFutureDriftMs: 100,
  });
  await second.generate();
  await secondState.close();

  const thirdState = await DurableGeneratorState.open({ directory });
  const third = new FencedSnowflakeGenerator({
    state: thirdState, clock, datacenterId: 0, workerId: 0,
    leaseDurationMs: 100, maxFutureDriftMs: 100,
  });
  await assert.rejects(third.generate(), ClockAheadOfFenceError);
  await thirdState.close();
});
