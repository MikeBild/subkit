import { catalogMetadataView } from "../../api/catalog-metadata.ts";
import type { ConnectorView, DriverName, Environment } from "../types.ts";

export interface ConnectorViewFacts {
  readonly id: string;
  readonly tenant_id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly description_source: string;
  readonly category: string;
  readonly category_source: string;
  readonly driver: string;
  readonly environment: string;
  readonly auth_type: string;
  readonly base_url: string | null;
  readonly dsn: string | null;
  readonly config: Record<string, unknown> | null;
  readonly operator_quirks: unknown;
  readonly template_slug: string | null;
  readonly template_name: string | null;
  readonly template_source: string | null;
  readonly template_version: number | null;
  readonly template_snapshot: Record<string, unknown> | null;
  readonly self_description: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly enabled: boolean | null;
  readonly last_error: string | null;
  readonly circuit_state: string | null;
  readonly circuit_opened_at: Date | null;
  readonly circuit_failure_count: number | null;
  readonly circuit_threshold: number | null;
  readonly circuit_reset_ms: number | null;
  readonly needs_reauth: boolean | null;
  readonly auth_failed_at: Date | null;
  readonly auth_failed_reason: string | null;
  readonly health_state: string | null;
  readonly health_reason: string | null;
  readonly health_error_code: string | null;
  readonly sunset_at: Date | null;
  readonly successor_uri: string | null;
}

export function toConnectorView(row: ConnectorViewFacts): ConnectorView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    ...catalogMetadataView(row),
    driver: row.driver as DriverName,
    environment: row.environment as Environment,
    auth_type: row.auth_type as ConnectorView["auth_type"],
    base_url: row.base_url ?? null,
    dsn: row.dsn ?? null,
    config: row.config ?? {},
    operator_quirks: (row.operator_quirks as ConnectorView["operator_quirks"]) ?? {},
    template_slug: row.template_slug ?? null,
    template_name: row.template_name ?? null,
    template_source: row.template_source as ConnectorView["template_source"],
    template_version: row.template_version ?? null,
    template_snapshot: row.template_snapshot ?? null,
    self_description: (row.self_description as ConnectorView["self_description"]) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    enabled: row.enabled ?? true,
    last_error: row.last_error ?? null,
    circuit_state: (row.circuit_state as ConnectorView["circuit_state"]) ?? "closed",
    circuit_opened_at: row.circuit_opened_at ?? null,
    circuit_failure_count: row.circuit_failure_count ?? 0,
    circuit_threshold: row.circuit_threshold ?? 5,
    circuit_reset_ms: row.circuit_reset_ms ?? 300000,
    needs_reauth: row.needs_reauth ?? false,
    auth_failed_at: row.auth_failed_at ?? null,
    auth_failed_reason: row.auth_failed_reason ?? null,
    health_state: row.health_state ?? "ok",
    health_reason: row.health_reason ?? null,
    health_error_code: row.health_error_code ?? null,
    sunset_at: row.sunset_at ?? null,
    successor_uri: row.successor_uri ?? null,
  };
}
