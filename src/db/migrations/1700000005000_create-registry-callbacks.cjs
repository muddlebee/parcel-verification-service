exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- The idempotency ledger. The unique constraint on
    -- (parcel_id, external_callback_id) is the actual dedup mechanism —
    -- durable across restarts, unlike a Redis SETNX. A second delivery of
    -- the same callback_id violates the constraint and is treated as a
    -- no-op rather than reapplying the transition.
    CREATE TABLE registry_callbacks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parcel_id UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
      external_callback_id TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('verified', 'rejected')),
      raw_payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (parcel_id, external_callback_id)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS registry_callbacks;`);
};
