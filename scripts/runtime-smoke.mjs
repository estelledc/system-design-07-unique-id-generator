import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const main = join(root, 'src', 'main.js');
const recoverScript = join(root, 'scripts', 'recover-lock.mjs');
const stateDirectory = await mkdtemp(join(tmpdir(), 'fenced-id-runtime-'));
const rawRequestId = 'runtime-private-request';

function start() {
  const child = spawn(process.execPath, [main], {
    cwd: root,
    env: {
      ...process.env,
      DATACENTER_ID: '3',
      HOST: '127.0.0.1',
      PORT: '0',
      STATE_DIRECTORY: stateDirectory,
      WORKER_ID: '7',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async started(timeoutMs = 5000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        for (const line of stdout.split('\n')) {
          if (line.includes('"event":"server_started"')) return JSON.parse(line);
        }
        if (child.exitCode !== null) throw new Error(`server exited during startup: ${child.exitCode}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('server startup timed out');
    },
    exited(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => reject(new Error('process exit timed out')), timeoutMs);
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
    },
  };
}

async function allocate(baseUrl, requestId, count) {
  const response = await fetch(`${baseUrl}/v1/ids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': requestId },
    body: JSON.stringify({ count }),
  });
  return { status: response.status, body: await response.json() };
}

let first;
let held;
let second;
try {
  first = start();
  const started = await first.started();
  const baseUrl = `http://127.0.0.1:${started.port}`;
  const allocation = await allocate(baseUrl, rawRequestId, 3);
  assert.equal(allocation.status, 200);
  assert.equal(allocation.body.replayed, false);
  const lock = JSON.parse(await readFile(join(stateDirectory, 'generator.lock'), 'utf8'));

  first.child.kill('SIGKILL');
  assert.equal((await first.exited()).signal, 'SIGKILL');

  held = start();
  const heldExit = await held.exited();
  assert.notEqual(heldExit.code, 0);
  assert.match(held.stderr(), /generator state is locked/);
  assert.ok(!held.stderr().includes(lock.token));

  const recovery = await run(process.execPath, [recoverScript], {
    cwd: root,
    env: {
      ...process.env,
      EXPECTED_LOCK_TOKEN: lock.token,
      PROCESS_DEATH_CONFIRMED: 'true',
      STATE_DIRECTORY: stateDirectory,
    },
    timeout: 5000,
  });
  assert.equal(recovery.stderr, '');
  assert.match(recovery.stdout, /stale_lock_recovery_receipt/);
  assert.ok(!recovery.stdout.includes(lock.token));

  second = start();
  const restarted = await second.started();
  const restartedBaseUrl = `http://127.0.0.1:${restarted.port}`;
  const replayed = await allocate(restartedBaseUrl, rawRequestId, 3);
  assert.equal(replayed.body.replayed, true);
  assert.deepEqual(replayed.body.ids, allocation.body.ids);
  const next = await allocate(restartedBaseUrl, 'runtime-next-request', 1);
  assert.ok(BigInt(next.body.ids[0]) > BigInt(allocation.body.ids.at(-1)));

  const exitPromise = second.exited();
  second.child.kill('SIGTERM');
  assert.deepEqual(await exitPromise, { code: 0, signal: null });
  assert.match(second.stdout(), /"event":"server_stopped"/);
  assert.equal(first.stderr(), '');
  assert.equal(second.stderr(), '');
  for (const output of [first.stdout(), second.stdout()]) {
    assert.ok(!output.includes(rawRequestId));
    for (const id of allocation.body.ids) assert.ok(!output.includes(id));
  }

  process.stdout.write(`${JSON.stringify({
    kind: 'crash_fence_recovery_receipt',
    node: process.version,
    firstAllocationCount: allocation.body.ids.length,
    forcedTermination: 'SIGKILL',
    lockBlockedUnreviewedRestart: true,
    exactTokenRecovery: true,
    requestReplayStable: true,
    newIdAfterFence: true,
    gracefulShutdownReleasedLock: true,
    requestIdentityLogged: false,
    allocatedIdsLogged: false,
    claimBoundary: 'single-host process crash, explicit stale-lock recovery, and durable timestamp/request WAL; not cross-host worker leasing or power-loss proof',
  })}\n`);
} catch (error) {
  first?.child.kill('SIGKILL');
  held?.child.kill('SIGKILL');
  second?.child.kill('SIGKILL');
  throw error;
}
