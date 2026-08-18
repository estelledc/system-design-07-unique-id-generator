# Threat model

## Assets and boundary

Assets are ID uniqueness, monotonicity within one worker, worker assignment, timestamp-fence state, durable request replay, lock recovery capability, and topology privacy. HTTP request IDs and batch counts are untrusted. Layout and worker settings are operator-controlled.

The server has no authentication, authorization, TLS, rate limit, distributed lease system, or tenant isolation. Loopback binding is a development guard only.

## Threats and controls

| Threat | Impact | Control here | Remaining responsibility |
|---|---|---|---|
| Same worker identity in two directories/hosts | Exact duplicate IDs | Negative collision test; identity-bound state; local exclusive lock | External exclusive worker lease with fencing and audit |
| False stale-lock recovery | Two live owners | Exact random token and explicit death assertion | Prove old process/host lease is dead before recovery |
| Recovery races a new start | Recovery may remove or bypass the wrong ownership state | Runbook freezes all start/recovery actors | Distributed orchestration mutex and fenced worker lease |
| Clock rollback | Duplicate or out-of-order IDs | Default reject; explicit tolerance; durable horizon | Clock monitoring and controlled synchronization |
| Restart storm | IDs far in the future | Maximum future-drift budget | Alert, stop failover loop, repair clock |
| Idempotency-key reuse | Wrong client receives prior allocation | Count binding and `409` | Authenticate callers and namespace request IDs |
| State truncation/corruption | Reused time or lost replay | Checksummed frames; fail-closed startup | Backups, authenticated storage, restore rehearsal |
| Lock-token disclosure | Unauthorized lock deletion | Mode `0600`; never log/return token | Secret-safe operator workflow and file access control |
| ID enumeration | Record discovery or traffic analysis | None; IDs are declared predictable | Object authorization independent of identifier; avoid public sequential lookup |
| Embedded topology/time disclosure | Infrastructure and activity inference | Explicit documentation | Use opaque public IDs or indirection when sensitive |
| Request flooding | WAL/disk/CPU exhaustion | Count/body bounds only | Authentication, rate limiting, quotas, admission control |

## Cryptographic boundary

SHA-256 checksums detect accidental frame corruption but are not MACs. Decimal IDs contain no randomness and are not authorization tokens. The lock token is random and sensitive, but it protects only the recovery command; it does not establish that the old process is dead.

## State ownership

The state directory is forced to mode `0700`; WAL and lock files use `0600`. These permissions assume a trustworthy local OS account. Shared volumes, root access, backups, snapshots, and container escape are outside the implementation. Never mount the same directory read-write into two generator processes.
