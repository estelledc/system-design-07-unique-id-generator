export class SystemClock {
  now() {
    return Date.now();
  }
}

export class ManualClock {
  #value;

  constructor(initialMs) {
    this.set(initialMs);
  }

  now() {
    return this.#value;
  }

  set(value) {
    if (!Number.isSafeInteger(value)) throw new TypeError('clock value must be a safe integer');
    this.#value = value;
  }

  advance(deltaMs) {
    if (!Number.isSafeInteger(deltaMs)) throw new TypeError('clock delta must be a safe integer');
    this.set(this.#value + deltaMs);
  }
}
