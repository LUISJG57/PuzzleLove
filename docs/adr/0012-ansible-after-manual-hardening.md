# ADR-0012: Harden by hand first, then codify with Ansible

**Status:** accepted

## Context
The operator wanted to learn each hardening step, and the server must also be reproducible.

## Decision
Harden the VPS interactively first (user, SSH, UFW, fail2ban, swap, Docker), then encode the same state in Ansible roles.
The playbook runs from Windows through a pinned Ansible container (`run.ps1`). It is verified with an idempotency test in
a systemd container and with `--check --diff` against production.

## Alternatives
- **Ansible from day one:** faster, but the operator learns less about what each change does.
- **Manual only:** leaves undocumented drift.

## Consequences
- The first dry run against production found real drift: swap was active but never persisted in `/etc/fstab`, and
  `swappiness` was not configured. Applying the playbook fixed both.
