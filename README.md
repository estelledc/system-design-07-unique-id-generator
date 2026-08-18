# Fenced Snowflake ID generator

A dependency-free Node.js implementation of signed-positive 63-bit, time-sortable IDs with durable timestamp fencing, per-request idempotency, clock rollback policy, exclusive local state ownership, and explicit crash-lock recovery.

The bit layout is the easy part. Uniqueness actually depends on three independent contracts:

1. no two live generators share the same datacenter/worker identity;
2. one process never reuses a timestamp/sequence pair after clock movement or restart;
3. a client retry after a lost response returns the same allocation.

This repository makes all three visible. It deliberately includes a negative test showing that identical worker configuration in two different state directories produces the same first ID. A local lock is not a global worker lease.

## Quick start

Requires Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm run check

STATE_DIRECTORY='.state' \
DATACENTER_ID='0' \
WORKER_ID='0' \
npm start
```

Allocate a durable batch:

```sh
curl -sS -X POST http://127.0.0.1:3000/v1/ids \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-import-20260818-0001' \
  --data '{"count":3}'
```

IDs are returned as decimal strings because a 63-bit integer exceeds JavaScript's exact JSON number range. Parse and compare them as database 64-bit integers or `BigInt`, not floating-point numbers.

## Problem contract

### Functional requirements

- Unique under a valid exclusive worker assignment.
- Positive numeric value within signed 64-bit storage.
- Roughly time-sortable without loading the referenced record.
- More than 10,000 generated IDs per second per process for a hot local batch.
- No coordinator call on every ID.
- Bounded clock rollback and future-drift policy.
- Crash restart cannot reuse any timestamp covered by the previous process's durable lease.
- Retried allocation request returns the same durable ID list.
- Decode layout fields for operations and debugging.

### Non-goals

- Strict global event order, gap-free `+1` sequences, unguessable tokens, or business timestamps.
- A distributed worker-lease allocator, NTP service, cross-host lock, consensus, or automatic failover.
- Authentication, rate limiting, multi-region deployment, or production SLA.
- Silent stale-lock deletion, unbounded future-time drift, or automatic state compaction.

## Layout

```text
0 | 41-bit milliseconds since 2026-01-01 UTC | 5-bit datacenter | 5-bit worker | 12-bit sequence
```

- The sign bit remains zero, so every ID fits in `0 .. 2^63-1`.
- The 41-bit timestamp lasts about 69.7 years; the decoder reports the exact final millisecond for this epoch.
- 32 datacenter values × 32 worker values allow 1,024 configured identities.
- A worker has 4,096 sequence values per logical millisecond.
- IDs from one live generator are strictly increasing. Across generators, the timestamp dominates, but events within the same millisecond are ordered by topology bits—not by a proven real-world happens-before relation.

The layout is versioned as `snowflake-41-5-5-12-v1`. A state directory is durably bound to that layout, epoch, datacenter, and worker; reopening it with another identity fails closed.

## Crash fence in one minute

Before issuing from a timestamp window, the process appends and syncs a high-watermark lease. With a 100 ms lease, it may issue IDs within that window without another state write. After a crash, the old high watermark is proof of the entire range the old process might have used, so the replacement begins at `highWatermark + 1`.

The gap is intentional. Reusing a possible old timestamp would be worse. A future-drift budget prevents repeated restarts from pushing IDs arbitrarily ahead of wall time.

An exclusive `generator.lock` prevents two processes from opening one state directory. `SIGKILL` leaves the lock in place. Recovery requires proof outside this program that the old process is dead, plus the exact random lock token. The token is a recovery capability and is never printed by the server or recovery command.

[Architecture](docs/architecture.md) specifies state ordering and failure windows. [Operations](docs/operations.md) defines the recovery procedure.

## Request idempotency

`POST /v1/ids` requires an `Idempotency-Key` and allocates 1–1,000 IDs. The timestamp lease is durable before generation; the request-to-ID mapping is appended and synced before the HTTP response. Therefore:

- a lost successful response can be retried and replays the same list;
- the same key with another count returns `409`;
- a crash after leasing/generating but before mapping may burn IDs, but the HTTP response was not acknowledged and the range is never reused.

The direct generator export does not provide request replay; callers that need it should use `IdService` or the HTTP API.

## Back-of-the-envelope estimate

At 10,000 IDs/s, one worker consumes about 10 sequence values per wall-clock millisecond on average, far below 4,096. A 100 ms lease covers about 1,000 IDs at that target rate without another timestamp-fence write; its absolute sequence capacity is 409,600 IDs if logical time consumes every millisecond in the window. Each durable HTTP request still appends its request mapping. One thousand worker identities at 10,000 IDs/s would be 10 million IDs/s arithmetically; it is not a tested cluster-capacity claim.

`npm run benchmark` generates 100,000 IDs under a fixed wall clock, verifies uniqueness and strict numeric increase, and fails below 10,000 IDs/s. That isolates the hot in-process generator. It excludes HTTP, request-ledger fsync, network, worker assignment, and production contention.

## What is actually tested

- field round trips, signed-positive maximum, horizon, and invalid input;
- sequence rollover, concurrent callers, clock rollback rejection/tolerance, restart fence, and future-drift stop;
- state/WAL permissions, checksums, truncation refusal, identity binding, request replay, and exclusive lock;
- exact-token stale-lock recovery after explicit process-death confirmation;
- duplicate worker configuration across separate directories as a collision counterexample;
- HTTP allocation/replay/decode, private logging boundary, invalid input, health, and metrics;
- real `SIGKILL`, blocked restart, explicit recovery CLI, stable request replay, higher post-fence ID, and graceful lock release.

Passing these gates does not prove cross-host worker uniqueness, power-loss durability, directory-entry persistence, global ordering, production security, deployment, SLA, or external acceptance. See [Verification](docs/verification.md).

## UUID correction

It is outdated to say all UUIDs are unsortable. [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7) defines UUIDv7 with a time-ordered 48-bit Unix-millisecond field. UUIDv7 remains 128 bits and has a different randomness/counter contract, so it does not satisfy this case's compact signed-64-bit requirement. It may be the better choice when coordination-free 128-bit IDs are acceptable.

## Source and clean-room note

The prompt came from the `Unique-Id Generator` chapter in [`liquidslr/system-design-notes`](https://github.com/liquidslr/system-design-notes/tree/9d8388721e7231442763ad37398b8d82224aa68f), whose reviewed tree did not declare a license. The historical reference is Twitter's archived [`snowflake-2010`](https://github.com/twitter-archive/snowflake/tree/b3f6a3c6ca8e1b6847baa6ff42bf72201e2c2231) source. No prose, diagram, or code was copied from either unlicensed tree; this implementation and documentation were written independently.

## License

[MIT](LICENSE)
