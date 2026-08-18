import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ManualClock } from '../src/clock.js';
import { DurableGeneratorState } from '../src/durable-state.js';
import { FencedSnowflakeGenerator } from '../src/generator.js';
import { CUSTOM_EPOCH_MS, parseId } from '../src/layout.js';

const count = 100_000;
const directory = await mkdtemp(join(tmpdir(), 'fenced-id-benchmark-'));
const state = await DurableGeneratorState.open({ directory });
const clock = new ManualClock(CUSTOM_EPOCH_MS + 60_000);
const generator = new FencedSnowflakeGenerator({
  state,
  clock,
  datacenterId: 1,
  workerId: 1,
  leaseDurationMs: 100,
  maxFutureDriftMs: 5000,
});

const startedAt = performance.now();
const ids = await generator.generate(count);
const elapsedMs = performance.now() - startedAt;
const idsPerSecond = Math.round(count / (elapsedMs / 1000));
assert.equal(new Set(ids).size, count);
for (let index = 1; index < ids.length; index += 1) assert.ok(BigInt(ids[index]) > BigInt(ids[index - 1]));
assert.ok(idsPerSecond >= 10_000, `throughput requirement missed: ${idsPerSecond} IDs/s`);
const first = parseId(ids[0]);
const last = parseId(ids.at(-1));
await state.close();

process.stdout.write(`${JSON.stringify({
  kind: 'local_hot_burst_receipt',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  count,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  idsPerSecond,
  unique: true,
  strictlyIncreasing: true,
  firstTimestampMs: first.timestampMs,
  lastTimestampMs: last.timestampMs,
  logicalLeadMs: last.timestampMs - clock.now(),
  durableStateRecords: state.stats().walRecords,
  requirementFloorIdsPerSecond: 10_000,
  claimBoundary: 'single-process fixed-wall-clock hot burst under one durable timestamp lease; excludes HTTP, network, cross-host worker allocation, and production load',
})}\n`);
