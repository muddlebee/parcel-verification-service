exports.shorthands = undefined;

// Metadata-only document attach (Swagger "send empty value", or clients that
// only record type without bytes). Brief allows "record metadata and write to
// local disk" — disk write is optional when there is no payload.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_size_bytes_check;
    ALTER TABLE documents ADD CONSTRAINT documents_size_bytes_check CHECK (size_bytes >= 0);
    ALTER TABLE documents ALTER COLUMN storage_path DROP NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Fail down if any metadata-only rows exist (size 0 / null path).
    DELETE FROM documents WHERE size_bytes = 0 OR storage_path IS NULL;
    ALTER TABLE documents ALTER COLUMN storage_path SET NOT NULL;
    ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_size_bytes_check;
    ALTER TABLE documents ADD CONSTRAINT documents_size_bytes_check CHECK (size_bytes > 0);
  `);
};
