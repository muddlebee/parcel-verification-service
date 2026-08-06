exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parcel_id UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      -- Local disk path per the brief ("no real file storage"). Never
      -- derived from the client-supplied file name — generated server-side
      -- to avoid path traversal / collisions.
      storage_path TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_documents_parcel_id ON documents(parcel_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS documents;`);
};
