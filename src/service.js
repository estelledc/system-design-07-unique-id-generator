import { SystemClock } from './clock.js';
import { DurableGeneratorState } from './durable-state.js';
import { FencedSnowflakeGenerator } from './generator.js';
import { IdService } from './id-service.js';

export async function openIdService({
  stateDirectory,
  datacenterId = 0,
  workerId = 0,
  leaseDurationMs = 100,
  maxFutureDriftMs = 5000,
  maxClockRollbackMs = 0,
  clock = new SystemClock(),
} = {}) {
  const state = await DurableGeneratorState.open({ directory: stateDirectory });
  try {
    const generator = new FencedSnowflakeGenerator({
      state,
      clock,
      datacenterId,
      workerId,
      leaseDurationMs,
      maxFutureDriftMs,
      maxClockRollbackMs,
    });
    await generator.ready();
    return { generator, service: new IdService({ generator, state }), state };
  } catch (error) {
    await state.close();
    throw error;
  }
}
