import { resolve } from 'node:path';

import { recoverStaleLock } from '../src/durable-state.js';

const directory = process.env.STATE_DIRECTORY;
const expectedToken = process.env.EXPECTED_LOCK_TOKEN;
if (!directory) throw new TypeError('STATE_DIRECTORY is required');
if (!expectedToken) throw new TypeError('EXPECTED_LOCK_TOKEN is required');
if (process.env.PROCESS_DEATH_CONFIRMED !== 'true') {
  throw new TypeError('PROCESS_DEATH_CONFIRMED must equal true');
}

const receipt = await recoverStaleLock({
  directory: resolve(directory),
  expectedToken,
  processDeathConfirmed: true,
});
process.stdout.write(`${JSON.stringify({
  kind: 'stale_lock_recovery_receipt',
  recoveredPid: receipt.recoveredPid,
  acquiredAt: receipt.acquiredAt,
})}\n`);
