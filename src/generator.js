import { SystemClock } from './clock.js';
import { ClockAheadOfFenceError, ClockRegressionError } from './errors.js';
import {
  CUSTOM_EPOCH_MS,
  MAX_SEQUENCE,
  MAX_TIMESTAMP_DELTA,
  encodeId,
  layoutMetadata,
} from './layout.js';

function boundedInteger(value, label, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export class FencedSnowflakeGenerator {
  #state;
  #clock;
  #datacenterId;
  #workerId;
  #leaseDurationMs;
  #maxFutureDriftMs;
  #maxClockRollbackMs;
  #logicalTimestamp = null;
  #sequence = 0;
  #lastObservedWall = null;
  #tail = Promise.resolve();
  #ready;

  constructor({
    state,
    clock = new SystemClock(),
    datacenterId,
    workerId,
    leaseDurationMs = 100,
    maxFutureDriftMs = 5000,
    maxClockRollbackMs = 0,
  }) {
    if (!state || typeof state.reserveHighWatermark !== 'function') {
      throw new TypeError('durable generator state is required');
    }
    const layout = layoutMetadata();
    this.#datacenterId = boundedInteger(datacenterId, 'datacenterId', { min: 0, max: layout.maxDatacenterId });
    this.#workerId = boundedInteger(workerId, 'workerId', { min: 0, max: layout.maxWorkerId });
    this.#leaseDurationMs = boundedInteger(leaseDurationMs, 'leaseDurationMs', { min: 1, max: 60_000 });
    this.#maxFutureDriftMs = boundedInteger(maxFutureDriftMs, 'maxFutureDriftMs', { min: 1, max: 300_000 });
    this.#maxClockRollbackMs = boundedInteger(maxClockRollbackMs, 'maxClockRollbackMs', { min: 0, max: 60_000 });
    if (this.#leaseDurationMs > this.#maxFutureDriftMs) {
      throw new TypeError('leaseDurationMs cannot exceed maxFutureDriftMs');
    }
    if (!clock || typeof clock.now !== 'function') throw new TypeError('clock.now is required');
    this.#state = state;
    this.#clock = clock;
    this.#ready = state.bindIdentity({
      layoutVersion: layout.layoutVersion,
      customEpochMs: layout.customEpochMs,
      datacenterId: this.#datacenterId,
      workerId: this.#workerId,
    });
    this.#ready.catch(() => undefined);
  }

  generate(count = 1) {
    boundedInteger(count, 'count', { min: 1, max: 100_000 });
    const job = this.#tail.then(async () => {
      await this.#ready;
      return this.#generateLocked(count);
    });
    this.#tail = job.catch(() => undefined);
    return job;
  }

  ready() {
    return this.#ready;
  }

  config() {
    return {
      ...layoutMetadata(),
      datacenterId: this.#datacenterId,
      workerId: this.#workerId,
      leaseDurationMs: this.#leaseDurationMs,
      maxFutureDriftMs: this.#maxFutureDriftMs,
      maxClockRollbackMs: this.#maxClockRollbackMs,
    };
  }

  stats() {
    return {
      logicalTimestamp: this.#logicalTimestamp,
      sequence: this.#sequence,
      lastObservedWall: this.#lastObservedWall,
      state: this.#state.stats(),
    };
  }

  async #generateLocked(count) {
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const wall = this.#readWallClock();
      if (this.#logicalTimestamp === null) {
        const firstTimestamp = Math.max(wall, this.#state.highWatermark() + 1);
        await this.#ensureLease(firstTimestamp, wall);
        this.#logicalTimestamp = firstTimestamp;
        this.#sequence = 0;
      } else if (wall > this.#logicalTimestamp) {
        await this.#ensureLease(wall, wall);
        this.#logicalTimestamp = wall;
        this.#sequence = 0;
      } else if (this.#sequence < MAX_SEQUENCE) {
        this.#sequence += 1;
      } else {
        const nextTimestamp = this.#logicalTimestamp + 1;
        await this.#ensureLease(nextTimestamp, wall);
        this.#logicalTimestamp = nextTimestamp;
        this.#sequence = 0;
      }

      const drift = this.#logicalTimestamp - wall;
      if (drift > this.#maxFutureDriftMs) {
        throw new ClockAheadOfFenceError(drift, this.#maxFutureDriftMs);
      }
      ids.push(encodeId({
        timestampMs: this.#logicalTimestamp,
        datacenterId: this.#datacenterId,
        workerId: this.#workerId,
        sequence: this.#sequence,
      }).toString());
    }
    return Object.freeze(ids);
  }

  #readWallClock() {
    const wall = this.#clock.now();
    if (!Number.isSafeInteger(wall) || wall < CUSTOM_EPOCH_MS) {
      throw new TypeError('clock must return a safe millisecond at or after the custom epoch');
    }
    if (this.#lastObservedWall !== null && wall < this.#lastObservedWall) {
      const delta = this.#lastObservedWall - wall;
      if (delta > this.#maxClockRollbackMs) throw new ClockRegressionError(delta);
    }
    this.#lastObservedWall = Math.max(this.#lastObservedWall ?? wall, wall);
    return wall;
  }

  async #ensureLease(timestamp, wall) {
    if (BigInt(timestamp - CUSTOM_EPOCH_MS) > MAX_TIMESTAMP_DELTA) {
      throw new RangeError('timestamp lease exceeds the 41-bit epoch range');
    }
    if (timestamp <= this.#state.highWatermark()) return;
    const maximumHighWatermark = wall + this.#maxFutureDriftMs;
    if (timestamp > maximumHighWatermark) {
      throw new ClockAheadOfFenceError(timestamp - wall, this.#maxFutureDriftMs);
    }
    const desired = timestamp + this.#leaseDurationMs - 1;
    const highWatermark = Math.min(desired, maximumHighWatermark);
    if (BigInt(highWatermark - CUSTOM_EPOCH_MS) > MAX_TIMESTAMP_DELTA) {
      throw new RangeError('timestamp lease exceeds the 41-bit epoch range');
    }
    await this.#state.reserveHighWatermark(highWatermark);
  }
}
