exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1:1 with parcels: the brief's payload has exactly one owner per
    -- submission, no requirement to reuse an owner across parcels.
    CREATE TABLE owners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parcel_id UUID NOT NULL UNIQUE REFERENCES parcels(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      mobile TEXT NOT NULL,
      aadhaar_number TEXT NOT NULL,
      pan_number TEXT NOT NULL,
      bank_account_number TEXT NOT NULL,
      ifsc TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS owners;`);
};
