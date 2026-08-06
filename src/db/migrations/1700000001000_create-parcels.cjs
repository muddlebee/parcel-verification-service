exports.shorthands = undefined;

exports.up = (pgm) => {
  // Native since PG13; extension guards older/alternate images.
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  pgm.sql(`
    CREATE TABLE parcels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      khata_no TEXT NOT NULL,
      plot_no TEXT NOT NULL,
      district TEXT NOT NULL,
      tehsil TEXT NOT NULL,
      village TEXT NOT NULL,
      area_sqft NUMERIC(12, 2) NOT NULL CHECK (area_sqft > 0),
      claimed_ownership_since DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'documents_pending', 'under_verification', 'verified', 'rejected', 'disputed')),
      -- Not part of the brief's 5-state machine. Tracks the outbound
      -- registry call separately from parcel state, so a partner outage
      -- surfaces to an operator (idle -> queued -> retrying -> exhausted/done)
      -- without inventing a 6th business state.
      registry_sync_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (registry_sync_status IN ('idle', 'queued', 'retrying', 'exhausted', 'done')),
      registry_reference_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_parcels_status ON parcels(status);
    CREATE INDEX idx_parcels_district ON parcels(district);
    -- Partial unique: most parcels have no reference yet (NULL), only the
    -- ones we've actually submitted to the partner need to be unique.
    CREATE UNIQUE INDEX idx_parcels_registry_reference_id
      ON parcels(registry_reference_id) WHERE registry_reference_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS parcels;`);
};
