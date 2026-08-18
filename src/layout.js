export const LAYOUT_VERSION = 'snowflake-41-5-5-12-v1';
export const CUSTOM_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
export const TIMESTAMP_BITS = 41n;
export const DATACENTER_BITS = 5n;
export const WORKER_BITS = 5n;
export const SEQUENCE_BITS = 12n;
export const MAX_TIMESTAMP_DELTA = (1n << TIMESTAMP_BITS) - 1n;
export const MAX_DATACENTER_ID = Number((1n << DATACENTER_BITS) - 1n);
export const MAX_WORKER_ID = Number((1n << WORKER_BITS) - 1n);
export const MAX_SEQUENCE = Number((1n << SEQUENCE_BITS) - 1n);
export const MAX_SIGNED_ID = (1n << 63n) - 1n;

const WORKER_SHIFT = SEQUENCE_BITS;
const DATACENTER_SHIFT = SEQUENCE_BITS + WORKER_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_BITS + DATACENTER_BITS;
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n;
const WORKER_MASK = (1n << WORKER_BITS) - 1n;
const DATACENTER_MASK = (1n << DATACENTER_BITS) - 1n;

function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

export function encodeId({ timestampMs, datacenterId, workerId, sequence }) {
  if (!Number.isSafeInteger(timestampMs)) throw new TypeError('timestampMs must be a safe integer');
  boundedInteger(datacenterId, 'datacenterId', MAX_DATACENTER_ID);
  boundedInteger(workerId, 'workerId', MAX_WORKER_ID);
  boundedInteger(sequence, 'sequence', MAX_SEQUENCE);
  const delta = BigInt(timestampMs - CUSTOM_EPOCH_MS);
  if (delta < 0n || delta > MAX_TIMESTAMP_DELTA) {
    throw new RangeError('timestamp is outside the 41-bit custom epoch range');
  }
  const id = (delta << TIMESTAMP_SHIFT)
    | (BigInt(datacenterId) << DATACENTER_SHIFT)
    | (BigInt(workerId) << WORKER_SHIFT)
    | BigInt(sequence);
  if (id < 0n || id > MAX_SIGNED_ID) throw new RangeError('ID is outside signed-positive 63-bit range');
  return id;
}

export function parseId(raw) {
  let id;
  if (typeof raw === 'bigint') id = raw;
  else if (typeof raw === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(raw)) id = BigInt(raw);
  else throw new TypeError('ID must be a canonical decimal string or bigint');
  if (id < 0n || id > MAX_SIGNED_ID) throw new RangeError('ID is outside signed-positive 63-bit range');
  const timestampDelta = id >> TIMESTAMP_SHIFT;
  const timestampMs = Number(timestampDelta) + CUSTOM_EPOCH_MS;
  return Object.freeze({
    id: id.toString(),
    layoutVersion: LAYOUT_VERSION,
    timestampMs,
    timestampIso: new Date(timestampMs).toISOString(),
    datacenterId: Number((id >> DATACENTER_SHIFT) & DATACENTER_MASK),
    workerId: Number((id >> WORKER_SHIFT) & WORKER_MASK),
    sequence: Number(id & SEQUENCE_MASK),
  });
}

export function layoutMetadata() {
  const finalTimestampMs = Number(MAX_TIMESTAMP_DELTA) + CUSTOM_EPOCH_MS;
  return Object.freeze({
    layoutVersion: LAYOUT_VERSION,
    signedPositiveBits: 63,
    timestampBits: Number(TIMESTAMP_BITS),
    datacenterBits: Number(DATACENTER_BITS),
    workerBits: Number(WORKER_BITS),
    sequenceBits: Number(SEQUENCE_BITS),
    customEpochMs: CUSTOM_EPOCH_MS,
    customEpochIso: new Date(CUSTOM_EPOCH_MS).toISOString(),
    finalTimestampMs,
    finalTimestampIso: new Date(finalTimestampMs).toISOString(),
    maxDatacenterId: MAX_DATACENTER_ID,
    maxWorkerId: MAX_WORKER_ID,
    maxSequence: MAX_SEQUENCE,
  });
}
