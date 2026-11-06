import type { WorkflowOperatingStatus } from "@shared/workflow-operating-status.ts";
import type { CatalogSource } from "../api/catalog-metadata.ts";
import type { WorkflowConnectorReference } from "./connector-refs.ts";
import type { WorkflowAuthorityEnvironmentSummary } from "./operating-status.ts";
import type { WorkflowDef } from "./types.ts";
import type { VersionAuthor } from "./version-author.ts";

export interface WorkflowView {
  operating_status?: WorkflowOperatingStatus;
  authority_environments?: Record<"dev" | "prod", WorkflowAuthorityEnvironmentSummary | null>;
  connector_references: WorkflowConnectorReference[];
  creator: VersionAuthor;
  checksum: string | null;
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  description_source: CatalogSource;
  category: string;
  category_source: CatalogSource;
  lifecycle: "draft" | "active" | "archived";
  current_version_id: string | null;
  draft_version_id?: string | null;
  current_version: number | null;
  created_at: Date;
  updated_at: Date;
  last_executed_at: Date | null;
  health_state: string;
  health_reason: string | null;
  health_changed_at: Date | null;
  invalid: boolean;
  definition: WorkflowDef;
  steps: WorkflowDef["steps"];
}
