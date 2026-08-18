# Security policy

## Supported version

Only the current `main` branch is maintained. This repository is an executable ID-generation study, not a hosted production service.

## Reporting

Use GitHub's private security-advisory flow. Never post a live stale-lock token, worker lease, state WAL, infrastructure identity, or credential in a public issue.

## Scope boundary

The process binds to loopback by default, but it has no client authentication, authorization, TLS, distributed worker-lease service, rate limit, encryption at rest, backup, or multi-tenant isolation. Generated IDs are predictable metadata, not secrets. See [Threat model](docs/threat-model.md).
