ALTER TABLE connectors
  ADD COLUMN needs_reauth boolean NOT NULL DEFAULT false,
  ADD COLUMN auth_failed_at timestamptz,
  ADD COLUMN auth_failed_reason text;
--> statement-breakpoint
CREATE INDEX connectors_needs_reauth_idx
  ON connectors (tenant_id)
  WHERE needs_reauth = true;
--> statement-breakpoint
ALTER TABLE tenants
  ADD COLUMN last_connector_reauth_scan_at timestamptz;
