exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- The defensible record the brief asks for: every state change, who
    -- did it, and why. from_state is nullable for the very first row
    -- (creation has no "from"); everything else is append-only, never
    -- updated or deleted.
    CREATE TABLE parcel_transitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parcel_id UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
      from_state TEXT
        CHECK (from_state IN ('submitted', 'documents_pending', 'under_verification', 'verified', 'rejected', 'disputed')),
      to_state TEXT NOT NULL
        CHECK (to_state IN ('submitted', 'documents_pending', 'under_verification', 'verified', 'rejected', 'disputed')),
      actor TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_parcel_transitions_parcel_id_created_at
      ON parcel_transitions(parcel_id, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS parcel_transitions;`);
};
