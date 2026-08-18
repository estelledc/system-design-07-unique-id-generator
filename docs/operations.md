# Operations guide

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `HOST` | `127.0.0.1` | Local bind; no built-in auth |
| `PORT` | `3000` | `0` selects an ephemeral port |
| `STATE_DIRECTORY` | `.state` | Exclusive durable state and lock |
| `DATACENTER_ID` | `0` | 0–31, externally assigned |
| `WORKER_ID` | `0` | 0–31 within datacenter, externally assigned |
| `LEASE_DURATION_MS` | `100` | Timestamp horizon persisted per fence |
| `MAX_FUTURE_DRIFT_MS` | `5000` | Maximum reserved/logical lead over wall clock |
| `MAX_CLOCK_ROLLBACK_MS` | `0` | Backward wall movement tolerated; zero fails closed |

Changing datacenter, worker, epoch, or layout against an existing state directory fails. Do not work around it by deleting state. A new identity needs a separately leased worker pair and fresh directory.

## External worker lease gate

Before start, prove that `(datacenterId, workerId)` is exclusively assigned to this live process/host generation. A config file copied to another host is not a lease. A production control plane needs lease expiry/fencing semantics that prevent an old isolated process from continuing after reassignment. This repository does not provide that service.

## Normal lifecycle

1. Validate worker lease and clock health.
2. Start once against its exclusive state directory.
3. Record layout version, worker identity, high watermark, and process deployment identity.
4. Scrape metrics and protect readiness behind the operator plane.
5. Send `SIGTERM` for normal replacement; wait for `server_stopped` before starting the successor.
6. Confirm the lock file disappeared on graceful shutdown.

## Crash-lock recovery

`SIGKILL`, host crash, or abrupt runtime termination intentionally leaves `generator.lock`.

1. Prove the old process cannot issue IDs. A missing PID on one host is insufficient if the state/worker lease moved across hosts.
2. Freeze every automated start and recovery actor for this worker identity. The local tool has no distributed recovery mutex; recovery and restart must not race.
3. Preserve the lock and state WAL as evidence.
4. Read the protected lock token without copying it into chat, shell history, tickets, or logs.
5. Run the recovery command with the exact token and explicit death confirmation:

```sh
STATE_DIRECTORY='.state' \
EXPECTED_LOCK_TOKEN='<read securely from generator.lock>' \
PROCESS_DEATH_CONFIRMED='true' \
npm run recover-lock
```

6. Verify the receipt names the expected old PID and does not print the token.
7. Start the successor. Confirm its first new ID timestamp is above the prior durable high watermark.

The command trusts the operator's death assertion. A false assertion can create two live owners and exact duplicates.

## Clock policy

- `CLOCK_REGRESSION`: stop allocation and investigate synchronization. Retrying with a new request ID is wrong.
- A nonzero rollback tolerance trades timestamp fidelity for availability while keeping the logical stream increasing.
- `CLOCK_AHEAD_OF_FENCE`: wait for wall time or stop the restart/failover loop. Raising the budget silently can make IDs misleadingly future-dated.
- NTP is an input-quality tool, not a replacement for durable state or exclusive worker identity.

## Signals and alerts

| Signal | Alert candidate |
|---|---|
| `fenced_id_clock_rejections_total` | Any sustained increase |
| Logical timestamp minus wall clock | Near future-drift budget |
| Durable high watermark jump per boot | Unexpected restart gap |
| `fenced_id_replayed_total` | Sudden retry storm or client timeout issue |
| State WAL bytes / request count | Retention or disk forecast breached |
| More than one live instance per worker lease | Immediate uniqueness incident |
| Lock held during planned rollout | Old process did not close or rollout overlapped |

Built-in counters reset on restart. Retain them externally.

## State growth and backup stop line

The request ledger and lease WAL are append-only. There is no safe pruning command. Production retention requires a crash-safe snapshot, a defined idempotency-key lifetime, atomic publication, rollback path, directory fsync policy, backup/restore receipts, and tests across every rename/truncate boundary.

Until then, capacity exhaustion is safer than forgetting an allocation and returning a different ID to a valid retry.

## Reproduce

```sh
npm ci --ignore-scripts
npm run check
```

The runtime smoke exercises `SIGKILL`, blocked unreviewed restart, exact-token recovery, durable request replay, higher post-fence allocation, and graceful lock release. It is single-host process evidence, not power-loss or cross-host fencing proof.
