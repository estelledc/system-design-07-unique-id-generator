import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

import {
  ClockAheadOfFenceError,
  ClockRegressionError,
  RequestConflictError,
} from './errors.js';

const MAX_BODY_BYTES = 2048;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(payload);
}

async function readJson(request) {
  const contentType = request.headers['content-type'];
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be a JSON object');
  }
  return body;
}

function requestId(request) {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value) || typeof value !== 'string' || !SAFE_REQUEST_ID.test(value)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is required and must be a safe identifier');
  }
  return value;
}

function metricsText(metrics) {
  return [
    '# TYPE fenced_id_requests_total counter',
    `fenced_id_requests_total ${metrics.requests}`,
    '# TYPE fenced_id_allocated_total counter',
    `fenced_id_allocated_total ${metrics.allocated}`,
    '# TYPE fenced_id_replayed_total counter',
    `fenced_id_replayed_total ${metrics.replayed}`,
    '# TYPE fenced_id_errors_total counter',
    `fenced_id_errors_total ${metrics.errors}`,
    '# TYPE fenced_id_clock_rejections_total counter',
    `fenced_id_clock_rejections_total ${metrics.clockRejections}`,
    '',
  ].join('\n');
}

export function createHttpService({ idService, state, logger = console.log }) {
  if (!idService || typeof idService.allocate !== 'function') throw new TypeError('idService is required');
  if (!state || typeof state.stats !== 'function') throw new TypeError('durable state is required');
  if (typeof logger !== 'function') throw new TypeError('logger must be a function');
  const metrics = { requests: 0, allocated: 0, replayed: 0, errors: 0, clockRejections: 0 };

  const server = createServer(async (request, response) => {
    const startedAt = performance.now();
    metrics.requests += 1;
    let status = 500;
    let event = 'request_failed';
    let count = null;
    let replayed = null;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health/live') {
        status = 200;
        event = 'health_live';
        sendJson(response, status, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        status = 200;
        event = 'health_ready';
        sendJson(response, status, { ok: true, config: idService.config(), state: state.stats() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        status = 200;
        event = 'metrics_read';
        const payload = metricsText(metrics);
        response.writeHead(status, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(payload),
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(payload);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/ids') {
        const body = await readJson(request);
        count = body.count ?? 1;
        if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
          throw new HttpError(400, 'INVALID_COUNT', 'count must be an integer between 1 and 1000');
        }
        const allocation = await idService.allocate({ requestId: requestId(request), count });
        replayed = allocation.replayed;
        if (replayed) metrics.replayed += count;
        else metrics.allocated += count;
        status = 200;
        event = replayed ? 'allocation_replayed' : 'ids_allocated';
        sendJson(response, status, {
          ok: true,
          ids: allocation.ids,
          count,
          replayed,
          layoutVersion: idService.config().layoutVersion,
        });
        return;
      }
      const decodePrefix = '/v1/ids/';
      if (request.method === 'GET' && url.pathname.startsWith(decodePrefix)) {
        const id = url.pathname.slice(decodePrefix.length);
        if (id.length === 0) throw new HttpError(404, 'NOT_FOUND', 'route not found');
        status = 200;
        event = 'id_decoded';
        sendJson(response, status, { ok: true, decoded: idService.decode(id) });
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'route not found');
    } catch (error) {
      metrics.errors += 1;
      if (error instanceof RequestConflictError) {
        status = 409;
        event = 'request_conflict';
        sendJson(response, status, { ok: false, error: { code: error.code } });
      } else if (error instanceof ClockRegressionError || error instanceof ClockAheadOfFenceError) {
        metrics.clockRejections += 1;
        status = 503;
        event = 'clock_rejected';
        sendJson(response, status, { ok: false, error: { code: error.code } }, { 'retry-after': '1' });
      } else if (error instanceof HttpError) {
        status = error.status;
        event = 'request_rejected';
        sendJson(response, status, { ok: false, error: { code: error.code, message: error.message } });
      } else if (error instanceof TypeError || error instanceof RangeError) {
        status = 400;
        event = 'request_rejected';
        sendJson(response, status, { ok: false, error: { code: 'INVALID_INPUT', message: error.message } });
      } else {
        status = 500;
        event = 'internal_error';
        sendJson(response, status, { ok: false, error: { code: 'INTERNAL_ERROR' } });
      }
    } finally {
      logger(JSON.stringify({
        event,
        method: request.method,
        status,
        count,
        replayed,
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      }));
    }
  });

  return { server, metrics };
}

export const httpLimits = Object.freeze({ maxBodyBytes: MAX_BODY_BYTES });
