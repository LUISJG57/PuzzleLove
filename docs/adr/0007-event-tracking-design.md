# ADR-0007: Append-only events with a non-blocking sink

**Status:** accepted

## Context
Analytics need gameplay facts (grabs, drops, sessions, completions) without slowing down or endangering the game.

## Decision
A Postgres table `analytics_events` with:
- a `bigserial` id, used as the extract watermark;
- a unique `event_id`, for idempotency;
- a versioned JSONB `payload`;
- context columns.

`RoomManager` calls `EventSink.track()`, which only appends to a memory buffer. A background flush inserts batches of up
to 500 rows every 2 s. The buffer is capped at 10,000 events, and failures are retried, never thrown.

Grabs and drops are separate events (owner's choice), plus `piece_abandoned` so every grab can be paired. Drag moves
are not recorded. Player display names are stored, also by the owner's choice.

## Alternatives
- **Kafka or Redpanda:** a streaming backbone the RAM budget cannot afford.
- **Tracking from the browser:** easy to spoof, and the server already knows the authoritative outcome.

## Consequences
- Gameplay never waits on analytics. A long database outage loses the oldest events, and the loss is logged.
- `event_id` makes retries and the downstream MERGE safe.
