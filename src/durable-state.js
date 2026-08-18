import { randomUUID, createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ConfigurationMismatchError,
  LockHeldError,
  RequestConflictError,
  StateCorruptionError,
} from './errors.js';
import { layoutMetadata, parseId } from './layout.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECIMAL_ID = /^(?:0|[1-9][0-9]{0,18})$/;

function checksum(payload) {
  return createHash('sha256').update(`state\0${JSON.stringify(payload)}`, 'utf8').digest('hex');
}

function encodeFrame(payload) {
  return `${JSON.stringify({ payload, checksum: checksum(payload) })}\n`;
}

function decodeLock(text) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new StateCorruptionError('lock file is not valid JSON');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new StateCorruptionError('lock file has an invalid shape');
  }
  return receipt;
}

function decodeFrame(line, lineNumber) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new StateCorruptionError(`invalid state JSON at line ${lineNumber}`);
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new StateCorruptionError(`invalid state frame at line ${lineNumber}`);
  }
  if (frame.checksum !== checksum(frame.payload)) {
    throw new StateCorruptionError(`state checksum mismatch at line ${lineNumber}`);
  }
  return frame.payload;
}

function validateRequest(requestId, count, ids) {
  if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) {
    throw new TypeError('requestId must be a 1-128 character safe identifier');
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
    throw new TypeError('request count must be an integer between 1 and 1000');
  }
  if (!Array.isArray(ids) || ids.length !== count || ids.some((id) => !DECIMAL_ID.test(id))) {
    throw new TypeError('request IDs must be canonical decimal strings matching count');
  }
  for (const id of ids) parseId(id);
}

function normalizeIdentity(raw) {
  const layout = layoutMetadata();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('generator identity must be an object');
  }
  const identity = {
    layoutVersion: raw.layoutVersion,
    customEpochMs: raw.customEpochMs,
    datacenterId: raw.datacenterId,
    workerId: raw.workerId,
  };
  if (identity.layoutVersion !== layout.layoutVersion || identity.customEpochMs !== layout.customEpochMs) {
    throw new ConfigurationMismatchError('state layout or custom epoch does not match this binary');
  }
  if (!Number.isSafeInteger(identity.datacenterId) || identity.datacenterId < 0
    || identity.datacenterId > layout.maxDatacenterId) {
    throw new TypeError('identity datacenterId is outside the layout');
  }
  if (!Number.isSafeInteger(identity.workerId) || identity.workerId < 0
    || identity.workerId > layout.maxWorkerId) {
    throw new TypeError('identity workerId is outside the layout');
  }
  return Object.freeze(identity);
}

export class DurableGeneratorState {
  #directory;
  #lockPath;
  #walPath;
  #lockToken;
  #identity = null;
  #highWatermark = -1;
  #requests = new Map();
  #tail = Promise.resolve();
  #ioFault = null;
  #closed = false;
  #walRecords = 0;

  static async open({ directory }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('state directory is required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lockPath = join(directory, 'generator.lock');
    const walPath = join(directory, 'generator.state.wal');
    const lockToken = randomUUID();
    let lockHandle;
    try {
      lockHandle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const receipt = decodeLock(await readFile(lockPath, 'utf8'));
      throw new LockHeldError({ pid: receipt.pid, acquiredAt: receipt.acquiredAt });
    }
    try {
      await lockHandle.writeFile(`${JSON.stringify({
        pid: process.pid,
        token: lockToken,
        acquiredAt: new Date().toISOString(),
      })}\n`, 'utf8');
      await lockHandle.sync();
    } finally {
      await lockHandle.close();
    }

    const state = new DurableGeneratorState({ directory, lockPath, walPath, lockToken });
    try {
      const walHandle = await open(walPath, 'a', 0o600);
      try {
        await walHandle.chmod(0o600);
      } finally {
        await walHandle.close();
      }
      await state.#replay();
      return state;
    } catch (error) {
      await state.#releaseOwnLock();
      throw error;
    }
  }

  constructor({ directory, lockPath, walPath, lockToken }) {
    this.#directory = directory;
    this.#lockPath = lockPath;
    this.#walPath = walPath;
    this.#lockToken = lockToken;
  }

  highWatermark() {
    return this.#highWatermark;
  }

  bindIdentity(rawIdentity) {
    return this.#enqueue(async () => {
      const identity = normalizeIdentity(rawIdentity);
      if (this.#identity) {
        if (JSON.stringify(this.#identity) !== JSON.stringify(identity)) {
          throw new ConfigurationMismatchError('state directory is already bound to another generator identity');
        }
        return { applied: false, identity: { ...this.#identity } };
      }
      const payload = { type: 'identity', identity: { ...identity } };
      await this.#append(payload);
      this.#apply(payload);
      return { applied: true, identity: { ...identity } };
    });
  }

  lookupRequest(requestId) {
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) {
      throw new TypeError('requestId must be a 1-128 character safe identifier');
    }
    const entry = this.#requests.get(requestId);
    return entry ? { count: entry.count, ids: [...entry.ids] } : null;
  }

  reserveHighWatermark(highWatermark) {
    return this.#enqueue(async () => {
      if (!this.#identity) throw new ConfigurationMismatchError('generator identity must be bound before leasing time');
      if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) {
        throw new TypeError('highWatermark must be a non-negative safe integer');
      }
      if (highWatermark <= this.#highWatermark) {
        throw new TypeError('highWatermark must increase strictly');
      }
      const payload = { type: 'lease', highWatermark };
      await this.#append(payload);
      this.#apply(payload);
      return highWatermark;
    });
  }

  recordRequest(requestId, count, ids) {
    return this.#enqueue(async () => {
      if (!this.#identity) throw new ConfigurationMismatchError('generator identity must be bound before allocations');
      validateRequest(requestId, count, ids);
      const existing = this.#requests.get(requestId);
      if (existing) {
        if (existing.count !== count || existing.ids.some((id, index) => id !== ids[index])) {
          throw new RequestConflictError(`requestId reused with a different allocation: ${requestId}`);
        }
        return { applied: false, ids: [...existing.ids] };
      }
      const payload = { type: 'request', requestId, count, ids: [...ids] };
      await this.#append(payload);
      this.#apply(payload);
      return { applied: true, ids: [...ids] };
    });
  }

  stats() {
    return {
      directoryMode: '0700',
      identity: this.#identity ? { ...this.#identity } : null,
      highWatermark: this.#highWatermark,
      requests: this.#requests.size,
      walRecords: this.#walRecords,
      ioFaulted: this.#ioFault !== null,
      locked: !this.#closed,
    };
  }

  async close() {
    await this.#tail;
    if (this.#closed) return;
    await this.#releaseOwnLock();
    this.#closed = true;
  }

  #enqueue(operation) {
    const job = this.#tail.then(async () => {
      if (this.#closed) throw new Error('generator state is closed');
      if (this.#ioFault) throw this.#ioFault;
      return operation();
    });
    this.#tail = job.catch(() => undefined);
    return job;
  }

  async #append(payload) {
    try {
      const handle = await open(this.#walPath, 'a', 0o600);
      try {
        await handle.writeFile(encodeFrame(payload), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.#ioFault = error;
      throw error;
    }
  }

  async #replay() {
    const text = await readFile(this.#walPath, 'utf8');
    if (text.length > 0 && !text.endsWith('\n')) {
      throw new StateCorruptionError('state WAL ends with an incomplete frame');
    }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length - 1; index += 1) {
      this.#apply(decodeFrame(lines[index], index + 1));
    }
  }

  #apply(payload) {
    if (payload?.type === 'identity') {
      const identity = normalizeIdentity(payload.identity);
      if (this.#identity && JSON.stringify(this.#identity) !== JSON.stringify(identity)) {
        throw new StateCorruptionError('state WAL contains conflicting generator identities');
      }
      if (this.#identity) return;
      if (this.#walRecords !== 0) throw new StateCorruptionError('generator identity must be the first state record');
      this.#identity = identity;
    } else if (payload?.type === 'lease') {
      if (!this.#identity) throw new StateCorruptionError('state lease precedes generator identity');
      if (!Number.isSafeInteger(payload.highWatermark) || payload.highWatermark <= this.#highWatermark) {
        throw new StateCorruptionError('state lease highWatermark is not strictly increasing');
      }
      this.#highWatermark = payload.highWatermark;
    } else if (payload?.type === 'request') {
      if (!this.#identity) throw new StateCorruptionError('request allocation precedes generator identity');
      validateRequest(payload.requestId, payload.count, payload.ids);
      const existing = this.#requests.get(payload.requestId);
      if (existing && (existing.count !== payload.count
        || existing.ids.some((id, index) => id !== payload.ids[index]))) {
        throw new StateCorruptionError(`conflicting request allocation in WAL: ${payload.requestId}`);
      }
      if (existing) return;
      this.#requests.set(payload.requestId, { count: payload.count, ids: Object.freeze([...payload.ids]) });
    } else {
      throw new StateCorruptionError('unsupported state WAL record type');
    }
    this.#walRecords += 1;
  }

  async #releaseOwnLock() {
    let receipt;
    try {
      receipt = decodeLock(await readFile(this.#lockPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new StateCorruptionError('generator lock disappeared');
      throw error;
    }
    if (receipt.token !== this.#lockToken) throw new StateCorruptionError('generator lock ownership changed');
    await unlink(this.#lockPath);
  }
}

export async function recoverStaleLock({ directory, expectedToken, processDeathConfirmed }) {
  if (processDeathConfirmed !== true) {
    throw new TypeError('processDeathConfirmed must be true for lock recovery');
  }
  if (typeof expectedToken !== 'string' || expectedToken.length < 16) {
    throw new TypeError('expectedToken is required for lock recovery');
  }
  const lockPath = join(directory, 'generator.lock');
  const receipt = decodeLock(await readFile(lockPath, 'utf8'));
  if (receipt.token !== expectedToken) throw new RequestConflictError('stale lock token does not match');
  await unlink(lockPath);
  return { recoveredPid: receipt.pid, acquiredAt: receipt.acquiredAt };
}
