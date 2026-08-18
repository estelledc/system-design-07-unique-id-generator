import { RequestConflictError } from './errors.js';
import { parseId } from './layout.js';

export class IdService {
  #generator;
  #state;
  #tail = Promise.resolve();

  constructor({ generator, state }) {
    if (!generator || typeof generator.generate !== 'function') throw new TypeError('generator is required');
    if (!state || typeof state.lookupRequest !== 'function') throw new TypeError('durable state is required');
    this.#generator = generator;
    this.#state = state;
  }

  allocate({ requestId, count = 1 }) {
    const job = this.#tail.then(async () => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
        throw new TypeError('count must be an integer between 1 and 1000');
      }
      const existing = this.#state.lookupRequest(requestId);
      if (existing) {
        if (existing.count !== count) {
          throw new RequestConflictError(`requestId already allocated ${existing.count} IDs`);
        }
        return { ids: Object.freeze(existing.ids), replayed: true };
      }
      const ids = await this.#generator.generate(count);
      await this.#state.recordRequest(requestId, count, ids);
      return { ids, replayed: false };
    });
    this.#tail = job.catch(() => undefined);
    return job;
  }

  decode(id) {
    return parseId(id);
  }

  config() {
    return this.#generator.config();
  }

  stats() {
    return this.#generator.stats();
  }
}
