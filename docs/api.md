# HTTP API

The server binds to `127.0.0.1` by default and has no client authentication or TLS. Put it behind a trusted authenticated service before any non-local use.

## Allocate IDs

`POST /v1/ids`

Required header:

```text
Idempotency-Key: 1-128 ASCII letters, digits, dot, underscore, or hyphen
```

Optional JSON body:

```json
{ "count": 3 }
```

`count` defaults to 1 and must be 1–1,000. The response uses decimal strings:

```json
{
  "ok": true,
  "ids": ["103079219200"],
  "count": 1,
  "replayed": false,
  "layoutVersion": "snowflake-41-5-5-12-v1"
}
```

The exact value above is only a shape example. Do not send IDs as JSON numbers in JavaScript: values above `2^53-1` lose integer precision.

The request mapping is synced before success. A retry with the same key and count returns the same list with `replayed: true`. Reuse with another count returns `409 REQUEST_CONFLICT`.

## Decode an ID

`GET /v1/ids/{canonical-decimal-id}`

The response reports layout version, timestamp, ISO rendering, datacenter, worker, and sequence. Decode is observability—not proof that the embedded timestamp equals the referenced business event time. A crash restart or bounded clock rollback can intentionally move logical time ahead.

## Health and metrics

- `GET /health/live`: HTTP process is responsive.
- `GET /health/ready`: layout, worker identity, clock/fence settings, high watermark, state-record count, and lock status.
- `GET /metrics`: Prometheus text counters for requests, newly allocated IDs, replayed IDs, errors, and clock rejections.

Readiness never exposes the random lock token. It does expose worker topology and belongs on a trusted operator plane.

## Errors

| Status | Code | Meaning |
|---:|---|---|
| 400 | `INVALID_IDEMPOTENCY_KEY` | Missing or unsafe request identity |
| 400 | `INVALID_COUNT` / `INVALID_INPUT` | Count or decimal ID outside contract |
| 409 | `REQUEST_CONFLICT` | Durable request key already has another allocation contract |
| 413 | `BODY_TOO_LARGE` | More than 2 KiB request body |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Declared content type is not JSON |
| 503 | `CLOCK_REGRESSION` | Wall clock moved backward beyond policy |
| 503 | `CLOCK_AHEAD_OF_FENCE` | Safe logical time would exceed future-drift budget |

Clock errors include `Retry-After: 1`, but callers must use a bounded retry policy and the same idempotency key. A retry header is not a promise that the clock will recover in one second.
