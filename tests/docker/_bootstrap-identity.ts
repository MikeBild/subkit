export type BootstrapIdentity = {
  tenantId: string;
  tenantSlug: string;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIdentity(value: unknown): value is { tenant_id: string; tenant_slug: string } {
  if (!value || typeof value !== "object") return false;
  const identity = value as { tenant_id?: unknown; tenant_slug?: unknown };
  return (
    typeof identity.tenant_id === "string" &&
    UUID.test(identity.tenant_id) &&
    typeof identity.tenant_slug === "string" &&
    identity.tenant_slug.trim().length > 0
  );
}

export async function resolveBootstrapIdentity(
  baseUrl: string,
  adminKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<BootstrapIdentity> {
  const response = await fetchImpl(`${baseUrl}/v1/identity/whoami`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  if (!response.ok) {
    throw new Error(`GET /v1/identity/whoami failed: ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("GET /v1/identity/whoami returned invalid JSON");
  }
  if (!isIdentity(body)) {
    throw new Error("GET /v1/identity/whoami returned an invalid tenant identity");
  }
  return { tenantId: body.tenant_id, tenantSlug: body.tenant_slug };
}
