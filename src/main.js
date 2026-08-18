import { resolve } from 'node:path';

import { createHttpService } from './http-server.js';
import { openIdService } from './service.js';

function integerEnvironment(name, defaultValue, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const host = process.env.HOST ?? '127.0.0.1';
const port = integerEnvironment('PORT', 3000, { min: 0, max: 65_535 });
const stateDirectory = resolve(process.env.STATE_DIRECTORY ?? '.state');
const { service, state } = await openIdService({
  stateDirectory,
  datacenterId: integerEnvironment('DATACENTER_ID', 0, { min: 0, max: 31 }),
  workerId: integerEnvironment('WORKER_ID', 0, { min: 0, max: 31 }),
  leaseDurationMs: integerEnvironment('LEASE_DURATION_MS', 100, { min: 1, max: 60_000 }),
  maxFutureDriftMs: integerEnvironment('MAX_FUTURE_DRIFT_MS', 5000, { min: 1, max: 300_000 }),
  maxClockRollbackMs: integerEnvironment('MAX_CLOCK_ROLLBACK_MS', 0, { min: 0, max: 60_000 }),
});
const { server } = createHttpService({ idService: service, state });

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
} catch (error) {
  await state.close();
  throw error;
}
const address = server.address();
process.stdout.write(`${JSON.stringify({
  event: 'server_started',
  host,
  port: typeof address === 'object' && address ? address.port : port,
  config: service.config(),
})}\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  await state.close();
  process.stdout.write(`${JSON.stringify({ event: 'server_stopped', signal })}\n`);
}

process.once('SIGTERM', () => { stop('SIGTERM').catch((error) => { throw error; }); });
process.once('SIGINT', () => { stop('SIGINT').catch((error) => { throw error; }); });
