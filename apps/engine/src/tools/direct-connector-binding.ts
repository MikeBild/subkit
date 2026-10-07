import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ResolvedConnectorCredential } from "../connectors/drivers/http.ts";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { ConnectorView } from "../connectors/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { connectors, toolApprovals } from "../db/schema/index.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import type { ResolvedAuthorityReference } from "../llm/substitution/resolver.ts";
import { authorityConnectorDigest } from "../workflows/authority-configuration.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { approvalOwnerFilter } from "./approval-owner.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const connectorBindingSchema = z
  .object({
    connector_id: z.string().uuid(),
    environment: z.enum(["dev", "prod"]),
    configuration_digest: digest,
    credential_binding_digest: digest.nullable(),
    credential_id: z.string().uuid().nullable(),
    credential_revision: z.number().int().min(1).nullable(),
    connection_authority: z
      .object({ id: z.string().uuid(), revision: z.number().int().min(1) })
      .strict()
      .nullable(),
  })
  .strict();

export const DirectConnectorBindingSchema = z
  .object({
    schema_version: z.literal(1),
    tool: z.enum(["call_connector", "probe_connector"]),
    target: connectorBindingSchema,
    references: z.array(connectorBindingSchema).max(1000),
    review: z.object({ step: z.string(), method: z.string(), url: z.string().nullable() }).strict(),
  })
  .strict();
export type DirectConnectorBinding = z.infer<typeof DirectConnectorBindingSchema>;
type ConnectorBinding = z.infer<typeof connectorBindingSchema>;
export type LoadedConnectorCredential = Pick<
  ResolvedConnectorCredential,
  "credential_id" | "credential_revision" | "connection_authority"
>;

export interface DirectConnectorApproval {
  approval_id: string;
  surface: "chat" | "mcp";
  tool: "call_connector" | "probe_connector";
  binding: DirectConnectorBinding | null;
}

export function isDirectConnectorTool(tool: string): tool is DirectConnectorApproval["tool"] {
  return tool === "call_connector" || tool === "probe_connector";
}

async function readBinding(
  db: Executor,
  tenant: string,
  id: string,
  environment: "dev" | "prod",
  credentialsNeeded: boolean,
): Promise<ConnectorBinding | null> {
  const system = await loadConnectorSystem(tenant, id, environment, db);
  if (!system?.connector.enabled || system.connector.needs_reauth) return null;
  const metadata = credentialsNeeded ? await system.getAuthorityMetadata() : null;
  if (credentialsNeeded && !metadata?.available) return null;
  return connectorBindingSchema.parse({
    connector_id: system.id,
    environment: system.environment,
    configuration_digest: authorityConnectorDigest(system.connector),
    credential_binding_digest: metadata ? workflowJsonDigest(metadata.binding) : null,
    credential_id: metadata?.binding.primary?.id ?? null,
    credential_revision: metadata?.binding.primary?.revision ?? null,
    connection_authority: metadata?.binding.connection
      ? { id: metadata.binding.connection.id, revision: metadata.binding.connection.revision }
      : null,
  });
}

async function findConnector(
  db: Executor,
  tenant: string,
  identity: { id: string } | { slug: string; environment?: "dev" | "prod" },
) {
  const [connector] = await db
    .select({
      id: connectors.id,
      environment: connectors.environment,
      auth_type: connectors.auth_type,
      base_url: connectors.base_url,
      dsn: connectors.dsn,
      driver: connectors.driver,
      slug: connectors.slug,
      config: connectors.config,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant),
        isNull(connectors.deleted_at),
        "id" in identity
          ? eq(connectors.id, identity.id)
          : and(
              eq(connectors.slug, identity.slug),
              ...(identity.environment ? [eq(connectors.environment, identity.environment)] : []),
            ),
      ),
    )
    .limit(1);
  return connector;
}

function referencedSlugs(value: unknown, found = new Map<string, boolean>()): Map<string, boolean> {
  if (typeof value === "string") {
    for (const token of parsePlaceholders(value).tokens) {
      if (token.slug)
        found.set(token.slug, token.kind === "cred" || found.get(token.slug) === true);
    }
  } else if (Array.isArray(value)) {
    for (const child of value) referencedSlugs(child, found);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) referencedSlugs(child, found);
  }
  if (found.size > 1000) throw new Error("Too many connector authority references");
  return found;
}

export function directConnectorUrl(
  connector: { driver: string; base_url: string | null; dsn: string | null; config: unknown },
  args: { path?: unknown },
): string | null {
  try {
    let resolved: URL;
    if (connector.driver === "s3") {
      const config = connector.config as Record<string, unknown>;
      const region = typeof config.region === "string" ? config.region : "us-east-1";
      const endpoint =
        typeof config.endpoint === "string" ? config.endpoint : `s3.${region}.amazonaws.com`;
      if (typeof config.bucket !== "string" || !config.bucket) throw new Error("Missing bucket");
      resolved = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
      const key = typeof args.path === "string" ? args.path.replace(/^\//, "") : "";
      if (config.force_path_style === false) {
        resolved.hostname = `${config.bucket}.${resolved.hostname}`;
        resolved.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`;
      } else {
        resolved.pathname = `${resolved.pathname.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
      }
    } else
      resolved =
        connector.driver === "postgres"
          ? new URL(connector.dsn ?? "")
          : connector.driver === "graphql"
            ? new URL(connector.base_url ?? "")
            : resolveUrl(connector.base_url, typeof args.path === "string" ? args.path : "/");
    resolved.username = "";
    resolved.password = "";
    resolved.search = "";
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

export async function captureDirectConnectorBinding(p: {
  db: Executor;
  tenant_id: string;
  tool: string;
  args: Record<string, unknown>;
}): Promise<DirectConnectorBinding | null> {
  if (!isDirectConnectorTool(p.tool)) return null;
  const environment: "dev" | "prod" = p.args.environment === "prod" ? "prod" : "dev";
  const identity =
    p.tool === "call_connector"
      ? { id: typeof p.args.connector_id === "string" ? p.args.connector_id : "" }
      : {
          slug: typeof p.args.connector_slug === "string" ? p.args.connector_slug : "",
          ...(p.args.environment === undefined ? {} : { environment }),
        };
  if ("id" in identity && !z.string().uuid().safeParse(identity.id).success) return null;
  const connector = await findConnector(p.db, p.tenant_id, identity);
  if (!connector) return null;
  const target = await readBinding(
    p.db,
    p.tenant_id,
    connector.id,
    connector.environment,
    connector.auth_type !== "none",
  );
  if (!target) return null;
  const references: ConnectorBinding[] = [];
  if (p.tool === "probe_connector") {
    const slugs = referencedSlugs({
      path: p.args.path,
      headers: p.args.headers,
      query: p.args.query,
      body: p.args.body,
    });
    for (const [slug, credentialsNeeded] of [...slugs].sort(([a], [b]) => a.localeCompare(b))) {
      const referenced = await findConnector(p.db, p.tenant_id, {
        slug,
        environment: connector.environment,
      });
      if (!referenced) return null;
      const binding = await readBinding(
        p.db,
        p.tenant_id,
        referenced.id,
        referenced.environment,
        credentialsNeeded,
      );
      if (!binding) return null;
      references.push(binding);
    }
  }
  const url = directConnectorUrl(connector, p.args);
  return DirectConnectorBindingSchema.parse({
    schema_version: 1,
    tool: p.tool,
    target,
    references,
    review: {
      step: `${p.tool}: ${connector.slug} (${connector.environment})`,
      method:
        typeof p.args.method === "string"
          ? p.args.method
          : connector.driver === "postgres"
            ? "SQL"
            : "GET",
      url,
    },
  });
}

export class DirectConnectorBindingError extends Error {
  readonly code = "connector_authority_changed";
  constructor() {
    super(
      "The connector action requires a new decision because its approved access or configuration is no longer valid.",
    );
    this.name = "DirectConnectorBindingError";
  }
}

export async function assertDirectConnectorBinding(p: {
  db: Db;
  tenant_id: string;
  principal: ResolvedPrincipal;
  approval: DirectConnectorApproval;
  connector: ConnectorView;
  credential: LoadedConnectorCredential;
  references?: readonly ResolvedAuthorityReference[];
}): Promise<{ redirect: "manual" }> {
  const deny = (): never => {
    throw new DirectConnectorBindingError();
  };
  try {
    return await p.db.transaction(async (tx) => {
      const parsed = DirectConnectorBindingSchema.safeParse(p.approval.binding);
      if (!parsed.success) throw new DirectConnectorBindingError();
      const binding = parsed.data;
      if (binding.tool !== p.approval.tool) deny();
      const [decision] = await tx
        .select({ id: toolApprovals.id })
        .from(toolApprovals)
        .where(
          and(
            eq(toolApprovals.tenant_id, p.tenant_id),
            eq(toolApprovals.id, p.approval.approval_id),
            eq(toolApprovals.principal_id, p.principal.id),
            approvalOwnerFilter(p.principal),
            eq(toolApprovals.tool, p.approval.tool),
            eq(toolApprovals.surface, p.approval.surface),
            isNotNull(toolApprovals.granted_at),
            isNotNull(toolApprovals.consumed_at),
            isNull(toolApprovals.declined_at),
            sql`${toolApprovals.expires_at} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (!decision || p.principal.tenant_id !== p.tenant_id) deny();
      if (
        binding.target.connector_id !== p.connector.id ||
        binding.target.environment !== p.connector.environment ||
        binding.target.configuration_digest !== authorityConnectorDigest(p.connector) ||
        binding.target.credential_id !== p.credential.credential_id ||
        binding.target.credential_revision !== p.credential.credential_revision ||
        workflowJsonDigest(binding.target.connection_authority) !==
          workflowJsonDigest(p.credential.connection_authority ?? null)
      )
        deny();
      for (const expected of [binding.target, ...binding.references]) {
        const current = await readBinding(
          tx,
          p.tenant_id,
          expected.connector_id,
          expected.environment,
          expected.credential_binding_digest !== null,
        );
        if (!current || workflowJsonDigest(current) !== workflowJsonDigest(expected)) deny();
      }
      for (const actual of p.references ?? []) {
        if (
          !binding.references.some(
            (expected) =>
              expected.connector_id === actual.connector_id &&
              expected.configuration_digest === actual.configuration_digest &&
              (actual.credential_id === null ||
                (expected.credential_id === actual.credential_id &&
                  expected.credential_revision === actual.credential_revision)),
          )
        )
          deny();
      }
      return { redirect: "manual" as const };
    });
  } catch (error) {
    if (error instanceof DirectConnectorBindingError) {
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          actor_type: p.principal.kind,
          actor_id: p.principal.id,
          action: AuditAction.APPROVAL_REJECTED,
          resource_type: p.approval.surface === "mcp" ? "mcp_tool_call" : "conversation_tool_call",
          resource_id: p.approval.approval_id,
          result: "denied",
          reason: error.code,
          metadata: {
            tool: p.approval.tool,
            connector_id: p.connector.id,
            request_source: p.approval.surface,
          },
        },
        p.db,
      );
    }
    throw error;
  }
}
