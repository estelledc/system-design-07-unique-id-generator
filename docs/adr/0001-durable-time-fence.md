# ADR 0001: Fence timestamp ranges before issuing IDs

- Status: accepted
- Date: 2026-08-18

## Context

A conventional in-memory Snowflake worker rejects clock rollback and waits at sequence exhaustion, but process restart loses `lastTimestamp` and sequence. Persisting every ID would make client latency and throughput depend on one fsync per ID. Ignoring restart state can reproduce an old timestamp/worker/sequence tuple.

The HTTP surface also needs a stable answer when a client retries after losing a response.

## Decision

Use the 41/5/5/12 signed-positive layout. Before issuing from a time range, sync a high-watermark lease that covers the entire possible timestamp window. On restart, begin strictly after the prior horizon. Serialize generation, fail clock rollback closed by default, bound future logical drift, and persist a request-to-ID batch record before HTTP success.

Bind every state directory to layout version, epoch, datacenter, and worker. Use atomic local lock creation for one process. A crash lock can be removed only with an explicit process-death assertion and exact random token.

## Alternatives considered

### Database ticket server

It can provide gap-aware centralized allocation and durable retry semantics, but every request coordinates with the service and the allocator becomes a separate availability/throughput system. It is a valid design when coordination is acceptable, not this case's chosen constraint.

### UUIDv7

RFC 9562 UUIDv7 is time ordered and decentralized, correcting the outdated “UUID is never sortable” claim. It uses 128 bits with a different randomness/counter model, so it violates the compact signed-64-bit requirement. Prefer it when 128 bits are acceptable and explicit worker identities are undesirable.

### Persist every last timestamp and sequence

It is simple to reason about but performs a durable write per generated ID. Rejected because the exercise has a 10,000 IDs/s per-process target and supports batches.

### In-memory Snowflake with NTP only

NTP reduces clock error but is not a durable restart fence or worker allocator. The archived Twitter implementation explicitly rejected backward time. Restart and duplicate identity remain separate risks, so this is insufficient.

### Random 64-bit IDs

They remove clock dependence but provide collision probability rather than deterministic uniqueness, and signed/time-order requirements reduce available entropy. Rejected for this contract.

## Consequences

- A crash can create gaps and future-dated IDs; it cannot safely reuse the fenced horizon.
- Lease duration trades durable-write frequency for restart gap.
- The request WAL grows without bound and needs a future retention/snapshot design.
- Stale-lock recovery is intentionally operational and can be dangerous if death confirmation is false.
- Cross-host worker leasing remains mandatory and unimplemented.
- Numeric ID order is useful for approximate time scans, not a global happens-before oracle.

## References

- [Twitter archived Snowflake 2010](https://github.com/twitter-archive/snowflake/tree/b3f6a3c6ca8e1b6847baa6ff42bf72201e2c2231)
- [RFC 9562 UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7)
