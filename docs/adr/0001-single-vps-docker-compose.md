# ADR-0001: One VPS with Docker Compose

**Status:** accepted

## Context
The project must run in production on a personal budget and be operable by one person. The only resource is a
Hostinger VPS with 8 GB RAM. AWS, GCP and Azure are out of scope.

## Decision
Run every service as a container on one host, orchestrated by Docker Compose, with explicit memory limits per service.

## Alternatives
- **k3s or Kubernetes:** a control plane costs roughly 0.5–1 GB of RAM, and scheduling does not help on one node.
- **Bare processes with systemd:** harder to reproduce, update and roll back than versioned images.

## Consequences
- Deploys, rollbacks and local rehearsals all use the same Compose files and scripts.
- There is no high availability; recovery means rebuilding the host (Ansible) and restoring backups.
- Memory limits are budgeted by hand (see [architecture §2](../architecture.md#2-containers-and-networks)).
