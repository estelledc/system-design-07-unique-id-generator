export class ClockRegressionError extends Error {
  constructor(deltaMs) {
    super(`wall clock moved backwards by ${deltaMs}ms`);
    this.name = 'ClockRegressionError';
    this.code = 'CLOCK_REGRESSION';
    this.deltaMs = deltaMs;
  }
}

export class ClockAheadOfFenceError extends Error {
  constructor(driftMs, maximumMs) {
    super(`logical timestamp would lead wall clock by ${driftMs}ms; maximum is ${maximumMs}ms`);
    this.name = 'ClockAheadOfFenceError';
    this.code = 'CLOCK_AHEAD_OF_FENCE';
    this.driftMs = driftMs;
    this.maximumMs = maximumMs;
  }
}

export class ConfigurationMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationMismatchError';
    this.code = 'CONFIGURATION_MISMATCH';
  }
}

export class LockHeldError extends Error {
  constructor(receipt) {
    super(`generator state is locked by pid ${receipt.pid ?? 'unknown'}`);
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
    this.receipt = Object.freeze(receipt);
  }
}

export class RequestConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestConflictError';
    this.code = 'REQUEST_CONFLICT';
  }
}

export class StateCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateCorruptionError';
    this.code = 'STATE_CORRUPT';
  }
}
