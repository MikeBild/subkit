-- Connectors become the owning row for external MCP servers.
--
-- Order inside this file is load-bearing and NOT drizzle-kit's default:
-- the two new CHECK constraints are added LAST, after the data has been
-- normalised and moved, so they see the final rows. The whole file runs
-- in one transaction (the migration runner wraps every statement), so a
-- RAISE anywhere below leaves the database exactly as it was.
--
-- `mcp_servers` rows are copied, not deleted: the client pool and the
-- legacy registration surface still read that table at this point. The
-- source table, `credentials.mcp_server_id` and the `mcp_oauth_states`
-- FK are dropped by the migration that removes those surfaces. Because
-- connector ids are preserved here, an in-flight `mcp_oauth_states` row
-- already names the id its connector now has, so that later drop is pure
-- DDL with no value rewrite.
CREATE TABLE "connector_mcp_sessions" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"negotiated_protocol_version" text,
	"server_capabilities" jsonb,
	"tools_manifest_hash" text,
	"last_handshake_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "connector_mcp_sessions" ADD CONSTRAINT "connector_mcp_sessions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_mcp_sessions" ADD CONSTRAINT "connector_mcp_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_mcp_sessions_tenant_idx" ON "connector_mcp_sessions" USING btree ("tenant_id");--> statement-breakpoint
-- Existing slugs were only ever validated as a non-empty string, so a
-- stored slug can violate the shape CHECK added at the end of this file.
-- Normalise those rows rather than aborting the deploy: workflows bind a
-- connector by uuid, so a slug rewrite does not break a definition, and
-- every rewrite leaves an audit row naming the old and new value.
DO $$
DECLARE
  r RECORD;
  base text;
  candidate text;
BEGIN
  FOR r IN
    SELECT "id", "tenant_id", "slug", "environment", "deleted_at"
      FROM "connectors"
     WHERE "slug" !~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$'
        OR "slug" ~ '__'
     ORDER BY "id"
  LOOP
    base := regexp_replace(r."slug", '[^a-zA-Z0-9_-]', '-', 'g');
    base := regexp_replace(base, '_{2,}', '-', 'g');
    base := regexp_replace(base, '^[^a-zA-Z0-9]+', '');
    base := regexp_replace(base, '[^a-zA-Z0-9]+$', '');
    base := regexp_replace(left(base, 64), '[^a-zA-Z0-9]+$', '');
    IF base = '' THEN
      base := 'connector';
    END IF;
    candidate := base;
    -- Uniqueness is scoped to live rows by `connectors_tenant_slug_env_key`,
    -- so a soft-deleted row needs no collision handling at all.
    IF r."deleted_at" IS NULL AND EXISTS (
      SELECT 1 FROM "connectors" c
       WHERE c."tenant_id" = r."tenant_id"
         AND c."slug" = candidate
         AND c."environment" = r."environment"
         AND c."deleted_at" IS NULL
         AND c."id" <> r."id"
    ) THEN
      -- Deviating from `base` is where a dev/prod pair can come apart.
      -- `getConnectorForEnvironment` finds a row's sibling by (tenant, slug,
      -- environment), so two rows that shared a rejected slug MUST come out
      -- sharing the new one. If only one of them needs the id suffix, the pair
      -- silently stops pairing — and the visible consequence is a prod run
      -- resolving to the dev connector. That is a wrong-environment execution,
      -- which costs more than a blocked deploy, so this raises instead of
      -- normalising and leaving the trail to explain it afterwards.
      --
      -- A sibling is detectable in either state: still carrying the original
      -- slug (not yet reached by this loop, which walks by id) or already
      -- rewritten to `base` (reached earlier).
      IF EXISTS (
        SELECT 1 FROM "connectors" c
         WHERE c."tenant_id" = r."tenant_id"
           AND c."environment" <> r."environment"
           AND c."deleted_at" IS NULL
           AND c."slug" IN (r."slug", base)
      ) THEN
        RAISE EXCEPTION
          'connector % (tenant %) has slug % which the new shape check rejects; the replacement % is already taken in environment %, but a sibling connector exists in another environment and would keep a different slug. Resolve the collision by hand before upgrading — otherwise getConnectorForEnvironment stops pairing the two and a prod run resolves to the dev connector.',
          r."id", r."tenant_id", r."slug", base, r."environment";
      END IF;
      candidate := left(base, 55) || '-' || left(replace(r."id"::text, '-', ''), 8);
    END IF;
    IF r."deleted_at" IS NULL AND EXISTS (
      SELECT 1 FROM "connectors" c
       WHERE c."tenant_id" = r."tenant_id"
         AND c."slug" = candidate
         AND c."environment" = r."environment"
         AND c."deleted_at" IS NULL
         AND c."id" <> r."id"
    ) THEN
      RAISE EXCEPTION
        'connector % (tenant %) has slug % which the new shape check rejects, and no free replacement slug exists in environment %',
        r."id", r."tenant_id", r."slug", r."environment";
    END IF;
    UPDATE "connectors" SET "slug" = candidate, "updated_at" = now() WHERE "id" = r."id";
    INSERT INTO "audit_log" ("id", "tenant_id", "actor_type", "actor_id", "action", "resource_type", "resource_id", "result", "reason", "metadata")
    VALUES (
      gen_random_uuid(), r."tenant_id", 'system', NULL, 'connector.updated', 'connector', r."id"::text, 'success',
      'connector_slug_shape_normalization',
      -- `environment` is carried so the trail alone answers the one question
      -- a rewrite can raise: `getConnectorForEnvironment` pairs a dev row
      -- with its prod sibling by (tenant, slug, environment), so two rows
      -- that shared a rejected slug must come out sharing the new one. When
      -- they do not — because the target was already taken in one
      -- environment — these rows are what shows it, without joining back to
      -- a table whose old values are gone.
      jsonb_build_object('previous_slug', r."slug", 'slug', candidate, 'environment', r."environment")
    );
  END LOOP;
END $$;--> statement-breakpoint
-- Copy every external MCP server into `connectors` as a `mcp`-driver row
-- and re-own its credentials.
--
-- The credential is re-owned IN PLACE. Its AES-GCM AAD is derived from
-- the credential's own id, so an UPDATE keeps the ciphertext decryptable
-- while a copy-and-delete would mint a new id and brick it permanently.
DO $$
DECLARE
  r RECORD;
  candidate text;
  slug_source text;
  mapped_auth_type "credential_mode";
  inner_cfg jsonb;
  is_enabled boolean;
  health text;
  health_code text;
  health_reason text;
BEGIN
  FOR r IN SELECT * FROM "mcp_servers" ORDER BY "created_at", "id" LOOP
    -- The namespace is the tool-name prefix (`mcp_<namespace>__<tool>`),
    -- so keeping it as the slug keeps every remote tool name, and every
    -- approval and transcript that named one, resolvable. The fallbacks
    -- are derived from the source row, so a re-run computes the same
    -- value instead of drifting.
    candidate := r."namespace";
    slug_source := 'namespace';
    IF EXISTS (
      SELECT 1 FROM "connectors" c
       WHERE c."tenant_id" = r."tenant_id" AND c."slug" = candidate
         AND c."environment" = 'prod' AND c."deleted_at" IS NULL
    ) THEN
      candidate := left(r."namespace", 60) || '-mcp';
      slug_source := 'namespace_mcp_suffix';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "connectors" c
       WHERE c."tenant_id" = r."tenant_id" AND c."slug" = candidate
         AND c."environment" = 'prod' AND c."deleted_at" IS NULL
    ) THEN
      candidate := left(r."namespace", 55) || '-' || left(replace(r."id"::text, '-', ''), 8);
      slug_source := 'namespace_id_suffix';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "connectors" c
       WHERE c."tenant_id" = r."tenant_id" AND c."slug" = candidate
         AND c."environment" = 'prod' AND c."deleted_at" IS NULL
    ) THEN
      RAISE EXCEPTION
        'mcp server % (tenant %, namespace %) cannot be migrated: every candidate slug is taken in environment prod',
        r."id", r."tenant_id", r."namespace";
    END IF;

    -- The id is preserved UNCONDITIONALLY, so audit rows, tasks, transcripts
    -- and in-flight OAuth state keep resolving to the same resource. There is
    -- deliberately no "mint a fresh uuid on collision" fallback: both id
    -- spaces are gen_random_uuid(), so a collision means someone inserted a
    -- connector with an mcp_servers id out of band, and a silent re-id would
    -- break the invariant the NEXT migration depends on — it re-owns
    -- `mcp_oauth_states` by RENAME, without rewriting values, because these
    -- ids match. A re-id would leave a pending authorization pointing at the
    -- unrelated connector that squatted the id, and the FK would still be
    -- satisfied, so the corruption would be silent. The INSERT below instead
    -- raises a primary-key violation, which aborts the whole (single-
    -- transaction) migration and leaves the database exactly as it was.
    --
    -- The declared auth kind and the credential's mode are two separate
    -- facts and are carried separately: `kind` stays verbatim in the
    -- config, `auth_type` is its connector-side equivalent. Where they
    -- disagree, that disagreement is the data.
    mapped_auth_type := (CASE coalesce(r."auth_config" ->> 'kind', 'none')
      WHEN 'bearer' THEN 'bearer'
      WHEN 'basic' THEN 'basic'
      WHEN 'oauth2' THEN 'oauth2'
      WHEN 'oauth2_client_credentials' THEN 'oauth2_client'
      WHEN 'oauth2_private_key_jwt' THEN 'oauth2_private_key'
      ELSE 'none'
    END)::"credential_mode";

    inner_cfg := jsonb_build_object(
      'transport', r."transport",
      'auth', coalesce(r."auth_config", jsonb_build_object('kind', 'none'))
    );
    IF r."transport" = 'stdio' THEN
      -- `url` holds a resolved command path for stdio. It must not land
      -- in base_url, which is treated as an egress target.
      inner_cfg := inner_cfg || jsonb_build_object('command', r."url");
    END IF;

    -- Only streamable HTTP is served. An sse/stdio row is carried so the
    -- registration is not silently lost, but never enabled: an
    -- unrunnable connector in the palette is worse than an absent one.
    is_enabled := (r."status" <> 'disabled') AND r."transport" = 'http';
    IF r."transport" <> 'http' THEN
      health := 'needs_update';
      health_code := 'mcp_transport_unsupported';
      health_reason := 'MCP transport ' || r."transport" || ' is not served; re-register over streamable HTTP';
    ELSIF r."status" = 'error' THEN
      health := 'degraded';
      health_code := 'mcp_handshake_failed';
      health_reason := r."last_error";
    ELSE
      health := 'ok';
      health_code := NULL;
      health_reason := NULL;
    END IF;

    INSERT INTO "connectors" (
      "id", "tenant_id", "slug", "display_name", "driver", "environment", "auth_type",
      "config", "base_url", "enabled", "last_error",
      "health_state", "health_reason", "health_error_code", "health_changed_at",
      "created_at", "updated_at"
    ) VALUES (
      r."id", r."tenant_id", candidate, r."name", 'mcp', 'prod', mapped_auth_type,
      jsonb_build_object('mcp', inner_cfg),
      CASE WHEN r."transport" = 'stdio' THEN NULL ELSE r."url" END,
      is_enabled, r."last_error",
      health, health_reason, health_code,
      CASE WHEN health = 'ok' THEN NULL ELSE now() END,
      r."created_at", now()
    );

    UPDATE "credentials"
       SET "connector_id" = r."id", "mcp_server_id" = NULL, "updated_at" = now()
     WHERE "mcp_server_id" = r."id";

    -- A row here asserts a negotiated session, so only a server that
    -- actually handshook gets one.
    IF r."tools_manifest_hash" IS NOT NULL OR r."last_handshake_at" IS NOT NULL THEN
      INSERT INTO "connector_mcp_sessions" ("connector_id", "tenant_id", "tools_manifest_hash", "last_handshake_at")
      VALUES (r."id", r."tenant_id", r."tools_manifest_hash", r."last_handshake_at");
    END IF;

    INSERT INTO "audit_log" ("id", "tenant_id", "actor_type", "actor_id", "action", "resource_type", "resource_id", "result", "reason", "metadata")
    VALUES (
      gen_random_uuid(), r."tenant_id", 'system', NULL, 'connector.created', 'connector', r."id"::text, 'success',
      'mcp_server_migration',
      jsonb_build_object(
        'source_mcp_server_id', r."id"::text,
        'previous_namespace', r."namespace",
        'slug', candidate,
        'slug_source', slug_source,
        'transport', r."transport",
        'previous_status', r."status",
        'enabled', is_enabled
      )
    );
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_slug_shape_check" CHECK ("connectors"."slug" ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$' AND "connectors"."slug" !~ '__');--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_mcp_auth_no_inline_secrets_check" CHECK ("connectors"."config" -> 'mcp' -> 'auth' IS NULL OR NOT (
        "connectors"."config" -> 'mcp' -> 'auth' ? 'client_secret' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'password' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'passphrase' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'api_key' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'apikey' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'access_token' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'refresh_token' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'bearer_token' OR
        "connectors"."config" -> 'mcp' -> 'auth' ? 'secret'
      ));
