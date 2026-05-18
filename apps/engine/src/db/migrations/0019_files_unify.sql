-- 0019: unified files resource.
--
-- Replaces the fragmented chat-attachment + knowledge-source file
-- storage with a single `files` table per tenant + polymorphic
-- `file_links` join. Every file the engine knows about now lives in
-- one place; the dedup constraint is sha256-scoped to the tenant, and
-- the lifecycle is captured by the `file_status` enum.
--
-- Backfill rules:
--
--   1) `conversation_attachments` rows become `files` rows with
--      `status='ready'` (they were already on disk / in object store
--      when the legacy row was written). Per-tenant sha256 dedup is
--      handled via `ON CONFLICT (tenant_id, sha256) DO NOTHING` — same
--      content uploaded twice in the same tenant collapses to one
--      `files` row. The `file_links` insert then joins on
--      `(tenant_id, sha256)` so multiple links can point at one file.
--
--   2) `knowledge_sources` rows where `source_type='file_upload'`
--      become `files` rows the same way. `source_uri` is the
--      legacy storage URI, `version` is the sha256 fingerprint of
--      the content. The `knowledge_sources.file_id` column is then
--      populated by sha256 lookup, and `source_uri` is cleared for
--      those rows only. The other three `source_type` variants
--      (`url`, `inline`, `discovery_endpoint_index`) are untouched —
--      their `source_uri` is the canonical reference and stays
--      `NOT NULL`.
--
--   3) `conversation_attachments` is dropped entirely. Production has
--      0 rows at deploy time (re-audited at execution time); the
--      no-shims rule says we cut clean rather than ship a view.
--
-- Row-count assertions abort the migration if the backfill disagrees
-- with the source data. The `<=` for `files` accounts for sha256
-- dedup collapsing rows; `=` for `file_links` because every legacy
-- attachment / file-upload knowledge source becomes exactly one link.

CREATE TYPE file_status AS ENUM
  ('pending', 'uploading', 'scanning', 'ready', 'failed', 'expired');

CREATE TYPE file_link_resource AS ENUM
  ('conversation', 'knowledge_source', 'skill', 'connector',
   'workflow_run', 'discovery_run');

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status file_status NOT NULL DEFAULT 'pending',
  filename text NOT NULL,
  content_type text,
  size_bytes bigint NOT NULL DEFAULT 0,
  storage_uri text NOT NULL,
  sha256 text,
  upload_url_expires_at timestamptz,
  scan_result text,
  anthropic_file_id text,
  openai_file_id text,
  gemini_file_id text,
  llm_file_expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX files_tenant_status_idx ON files (tenant_id, status);
CREATE UNIQUE INDEX files_tenant_sha256_uq ON files (tenant_id, sha256);

CREATE TABLE file_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  resource_type file_link_resource NOT NULL,
  resource_id uuid NOT NULL,
  slug text,
  role text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX file_links_tenant_resource_idx
  ON file_links (tenant_id, resource_type, resource_id);
CREATE UNIQUE INDEX file_links_conv_slug_uq
  ON file_links (tenant_id, resource_type, resource_id, slug);

-- ----- pre-backfill counters (for row-count assertions below) ---------------

DO $$
DECLARE
  pre_attach integer;
  pre_kfile integer;
  post_files integer;
  post_links_conv integer;
  post_links_ks integer;
  orphan_ks integer;
BEGIN
  SELECT count(*) INTO pre_attach FROM conversation_attachments;
  SELECT count(*) INTO pre_kfile
    FROM knowledge_sources WHERE source_type = 'file_upload';

  -- ----- ¶2: backfill files from conversation_attachments ------------------

  INSERT INTO files (
    tenant_id, status, filename, content_type, size_bytes, storage_uri,
    sha256, anthropic_file_id, created_by, created_at, updated_at
  )
  SELECT
    ca.tenant_id,
    'ready'::file_status,
    ca.original_filename,
    ca.content_type,
    ca.size_bytes,
    ca.storage_uri,
    ca.sha256,
    ca.files_api_id,
    NULL,
    ca.created_at,
    ca.created_at
  FROM conversation_attachments ca
  ON CONFLICT (tenant_id, sha256) DO NOTHING;

  -- ----- ¶3: backfill file_links from conversation_attachments -------------

  INSERT INTO file_links (
    tenant_id, file_id, resource_type, resource_id, slug, role, created_at
  )
  SELECT
    ca.tenant_id,
    f.id,
    'conversation'::file_link_resource,
    ca.conversation_id,
    ca.slug,
    'attachment',
    ca.created_at
  FROM conversation_attachments ca
  JOIN files f
    ON f.tenant_id = ca.tenant_id AND f.sha256 = ca.sha256;

  -- ----- ¶4: backfill files from knowledge_sources (file_upload) -----------

  INSERT INTO files (
    tenant_id, status, filename, content_type, size_bytes, storage_uri,
    sha256, created_by, created_at, updated_at
  )
  SELECT
    ks.tenant_id,
    'ready'::file_status,
    ks.name,
    ks.mime_type,
    ks.bytes_total,
    ks.source_uri,
    ks.version,
    NULL,
    ks.created_at,
    ks.updated_at
  FROM knowledge_sources ks
  WHERE ks.source_type = 'file_upload'
  ON CONFLICT (tenant_id, sha256) DO NOTHING;

  -- ----- ¶5: add knowledge_sources.file_id + populate ----------------------

  ALTER TABLE knowledge_sources
    ADD COLUMN file_id uuid REFERENCES files(id) ON DELETE SET NULL;

  UPDATE knowledge_sources ks
  SET file_id = f.id
  FROM files f
  WHERE ks.source_type = 'file_upload'
    AND f.tenant_id = ks.tenant_id
    AND f.sha256 = ks.version;

  -- ¶4 continued: link rows for file-upload knowledge sources.
  INSERT INTO file_links (
    tenant_id, file_id, resource_type, resource_id, slug, role, created_at
  )
  SELECT
    ks.tenant_id,
    ks.file_id,
    'knowledge_source'::file_link_resource,
    ks.id,
    ks.slug,
    'source',
    ks.created_at
  FROM knowledge_sources ks
  WHERE ks.source_type = 'file_upload'
    AND ks.file_id IS NOT NULL;

  -- `source_uri` is preserved for the url|inline|discovery_endpoint_index
  -- variants (Δ2). For `file_upload` rows post-migration, clear it once
  -- `file_id` is set — application code reads via `file_id` there.
  UPDATE knowledge_sources
  SET source_uri = ''
  WHERE source_type = 'file_upload' AND file_id IS NOT NULL;

  -- ----- ¶6: drop conversation_attachments entirely ------------------------

  DROP TABLE conversation_attachments;

  -- ----- ¶7: row-count assertions -----------------------------------------

  SELECT count(*) INTO post_files FROM files;
  SELECT count(*) INTO post_links_conv
    FROM file_links WHERE resource_type = 'conversation';
  SELECT count(*) INTO post_links_ks
    FROM file_links WHERE resource_type = 'knowledge_source';
  SELECT count(*) INTO orphan_ks
    FROM knowledge_sources
    WHERE source_type = 'file_upload' AND file_id IS NULL;

  -- `<=` because per-tenant sha256 dedup can collapse multiple legacy
  -- rows into one `files` row.
  IF post_files > pre_attach + pre_kfile THEN
    RAISE EXCEPTION
      'files-unify: files row count % exceeds pre-migration sum % (attachments=% + knowledge=%)',
      post_files, pre_attach + pre_kfile, pre_attach, pre_kfile;
  END IF;

  IF post_links_conv <> pre_attach THEN
    RAISE EXCEPTION
      'files-unify: file_links(conversation) count % does not equal pre-migration attachments %',
      post_links_conv, pre_attach;
  END IF;

  IF post_links_ks <> pre_kfile THEN
    RAISE EXCEPTION
      'files-unify: file_links(knowledge_source) count % does not equal pre-migration file_upload knowledge sources %',
      post_links_ks, pre_kfile;
  END IF;

  IF orphan_ks <> 0 THEN
    RAISE EXCEPTION
      'files-unify: % file_upload knowledge_sources still have NULL file_id after backfill',
      orphan_ks;
  END IF;
END $$;
