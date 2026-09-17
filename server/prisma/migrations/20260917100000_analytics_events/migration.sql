-- CreateTable
CREATE TABLE "analytics_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" SMALLINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "session_id" TEXT,
    "client_id" TEXT,
    "room_slug" TEXT,
    "room_type" TEXT,
    "puzzle_id" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_events_event_id_key" ON "analytics_events"("event_id");

-- CreateIndex
CREATE INDEX "analytics_events_occurred_at_idx" ON "analytics_events"("occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_event_type_occurred_at_idx" ON "analytics_events"("event_type", "occurred_at");

