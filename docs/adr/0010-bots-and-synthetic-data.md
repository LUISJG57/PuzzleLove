# ADR-0010: Live bots and synthetic history, always labeled

**Status:** accepted

## Context
A new game has almost no traffic, which leaves the analytics stack with nothing to show or test.

## Decision
1. **Live bots** play the global room over Socket.IO in production, named "🤖 …" with `client_id` `bot-…`, scaled by
   an hourly activity curve up to `BOTS_MAX`.
2. **Synthetic history** is generated with the real puzzle engine and inserted with `is_synthetic = true`. It is used
   locally and, for demonstration, as a 14-day history in production.
3. Every layer and dashboard carries `traffic_type` (human, bot or synthetic), and the public dashboard explains the
   distinction.

## Alternatives
- **Wait for organic traffic:** nothing to demonstrate for weeks.
- **Unlabeled fake data:** misleading, and it would contaminate real metrics permanently.

## Consequences
- Metrics stay honest as long as filters are used; the default views show all traffic with labels.
- Synthetic rows can be removed with `backfill --purge` followed by a full pipeline refresh.
- Generated ids must be unique across runs (see [journey](../journey.md), incident 23).
