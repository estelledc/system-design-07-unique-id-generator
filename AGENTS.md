# Unique ID generator contributor guide

- Never weaken uniqueness to preserve availability silently.
- Treat datacenter/worker assignment, wall-clock behavior, durable fencing, and client retry identity as separate contracts.
- Keep IDs within signed-positive 63 bits and preserve the declared layout/version.
- Clock rollback and sequence exhaustion require executable tests.
- A process crash leaves a lock; recovery must bind the exact lock token and an explicit process-death decision.
- Do not claim numeric time order means strict global event order.
- Do not copy prose, diagrams, or code from unlicensed notes or the archived Snowflake source.
- Run `npm run check` before handoff.
