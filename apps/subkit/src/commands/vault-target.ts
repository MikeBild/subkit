import type { Connector, ConnectorListResponse } from "../engine-client/connectors.ts";

export type VaultEnvironment = "dev" | "prod";

export interface VaultTargetClient {
  getConnector(id: string): Promise<Connector>;
  listConnectors(query: {
    environment?: VaultEnvironment;
    q?: string;
    limit?: number;
  }): Promise<Pick<ConnectorListResponse, "items">>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHABLE_MODES = new Set([
  "bearer",
  "header",
  "query",
  "basic",
  "aws_sigv4",
  "signed_jwt",
  "none",
]);

export function parseVaultEnvironment(value: unknown): VaultEnvironment | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "dev" || value === "prod") return value;
  throw new Error("--env must be dev or prod");
}

export function defaultCredentialMode(connector: Pick<Connector, "auth_type">): string {
  if (ATTACHABLE_MODES.has(connector.auth_type)) return connector.auth_type;
  throw new Error(
    `connector auth type '${connector.auth_type}' is not attached with a secret; pass --mode or sign in from Cockpit`,
  );
}

async function bySlug(
  client: VaultTargetClient,
  slug: string,
  environment: VaultEnvironment | undefined,
): Promise<Connector[]> {
  const { items } = await client.listConnectors({
    q: slug,
    limit: 200,
    ...(environment ? { environment } : {}),
  });
  return items.filter(
    (item) => item.slug === slug && (!environment || item.environment === environment),
  );
}

export async function resolveVaultTarget(
  client: VaultTargetClient,
  reference: string,
  environment: VaultEnvironment | undefined,
): Promise<Connector> {
  const named = UUID.test(reference) ? await client.getConnector(reference) : null;
  if (named && (!environment || named.environment === environment)) return named;
  const slug = named?.slug ?? reference;
  const matches = await bySlug(client, slug, environment);
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length === 0)
    throw new Error(
      environment
        ? `no ${environment} connector with slug '${slug}'; create it, or copy the dev connector with \`subkit connectors promote <dev-connector-id>\``
        : `no connector with slug or id '${reference}'`,
    );
  throw new Error(
    `connector '${slug}' exists in dev and prod; pass --env dev or --env prod to choose the record`,
  );
}

export function hasCredentialIn(
  connector: Pick<Connector, "credentials" | "environment">,
  environment: VaultEnvironment,
): boolean {
  return (connector.credentials ?? []).some(
    (credential) => credential.environment === environment && credential.mode !== "oauth2_client",
  );
}

export async function productionGap(
  client: VaultTargetClient,
  attached: Pick<Connector, "slug" | "environment">,
): Promise<string | null> {
  if (attached.environment !== "dev") return null;
  const [prod] = await bySlug(client, attached.slug, "prod");
  if (!prod) return null;
  const full = await client.getConnector(prod.id);
  if (hasCredentialIn(full, "prod")) return null;
  return `the production connector '${attached.slug}' has no credential, so automated runs in prod stay blocked; attach it with: subkit vault attach ${attached.slug} --env prod`;
}

export function targetLabel(connector: Pick<Connector, "display_name" | "slug" | "environment">) {
  return `${connector.display_name} (${connector.slug}, ${connector.environment})`;
}
