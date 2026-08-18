# Verification record

## Gate

`npm run check` executes:

1. syntax, portable-path, local-link, secret-pattern, skipped-test, required-artifact, and pinned-Action checks;
2. all Node tests;
3. a child-process crash/lock/recovery/replay smoke;
4. a 100,000-ID hot-burst benchmark with a 10,000 IDs/s floor;
5. `npm audit --audit-level=high`.

## Tested behaviors

- bit-field round trip, signed maximum, epoch horizon, numeric order, and invalid representation;
- sequence exhaustion, concurrent calls, clock rollback, tolerance boundary, restart fence, and future-drift stop;
- state identity binding, local lock exclusion, mode `0700`/`0600`, WAL replay, request idempotency, count conflict, truncation, and checksum refusal;
- explicit death confirmation plus exact-token lock recovery;
- same worker identity in two independent state directories producing an exact collision;
- HTTP allocate/replay/decode, request/ID logging boundary, input limits, health, and metrics;
- process `SIGKILL`, lock-blocked restart, recovery CLI, stable old allocation, higher new allocation, and graceful successor shutdown;
- 100,000 unique strictly increasing IDs under one fixed wall-clock burst.

No test is skipped. CI runs the same locked gate on Node 22, 24, and 26.

## Current receipts

The initial public CI receipt is pending repository publication. Replace this sentence only after the GitHub run is green.

## Evidence boundary

Passing the gate supports the listed layout, single-worker stream, local state, request replay, and process-crash claims in the tested environment. It does not establish:

- cross-host worker assignment or lease fencing;
- global event order, gap-free IDs, secrecy, or authorization;
- sudden-power-loss, storage-controller, directory-entry, or malicious-tamper durability;
- safe snapshot/compaction, bounded idempotency retention, backup, or restore;
- authenticated public service, rate limiting, production traffic, multi-region failover, deployment, SLA, or external acceptance.

## Reproduce locally

```sh
npm ci --ignore-scripts
npm run check
```

Benchmark output includes runtime, OS, architecture, count, elapsed time, rate, uniqueness/order checks, logical lead, state-record count, and claim boundary. The fixed-clock hot loop isolates generator capacity; it is not HTTP or cluster throughput.
