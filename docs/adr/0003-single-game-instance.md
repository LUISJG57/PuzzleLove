# ADR-0003: A single game server instance

**Status:** accepted

## Context
The original checklist included a load balancer. The game server keeps rooms, locks and pending moves in memory and is
the authority for snapping.

## Decision
Run exactly one game instance. Traefik acts as a reverse proxy only; there are no replicas.

## Alternatives
- **Replicas behind sticky sessions + Socket.IO Redis adapter:** each replica would still own its own copy of the global
  room. Correctness would require room ownership or shared state, which is a substantial redesign for traffic that one
  Node process handles easily.

## Consequences
- Game restarts disconnect players for a few seconds; state is saved on `SIGTERM` and restored on start.
- Scaling out is a documented future change, not a configuration flag.
