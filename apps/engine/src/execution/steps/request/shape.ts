// Small shape helpers used by the request driver.
//   - `checkRequired` enforces JSON-Schema `required` on inputs / outputs.
//   - `extractModelHint` + `pickModelField` recover the LLM model id
//     for the LLM-call audit row when a connector targets a provider.
//   - `deriveAuthMethodFromAuthType` maps a connector's declared
//     `auth_type` to the request_meta `auth_method` vocabulary.

export function checkRequired(value: unknown, schema: Record<string, unknown>): string[] {
  const required = schema.required as string[] | undefined;
  if (!required || !Array.isArray(required)) return [];
  if (typeof value !== "object" || value === null)
    return required.map((f) => `required field '${f}' is missing`);
  return required
    .filter((f) => !(f in (value as Record<string, unknown>)))
    .map((f) => `required field '${f}' is missing`);
}

/** Best-effort extract of the model identifier for the LLM-call audit
 *  row. Looks at the request body first (OpenAI / Anthropic both pass
 *  `model` in the JSON payload) and falls back to the response body's
 *  `model` field (Anthropic echoes it back). Returns `unknown` when
 *  neither side names a model — the audit row still records the host. */
export function extractModelHint(requestBody: unknown, responseBody: unknown): string {
  const fromReq = pickModelField(requestBody);
  if (fromReq) return fromReq;
  const fromRes = pickModelField(responseBody);
  if (fromRes) return fromRes;
  return "unknown";
}

function pickModelField(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const m = (v as Record<string, unknown>).model;
  return typeof m === "string" && m.length > 0 ? m : null;
}

/** Map a connector's declared `auth_type` to the applied-auth-method
 *  vocabulary used in request_meta.connector.auth_method. For HTTP
 *  requests this is overwritten with the plan's observed value (which
 *  distinguishes oauth2_refreshed vs oauth2_static). GraphQL/S3 paths
 *  use this directly since they don't do inline oauth2 refresh. */
export function deriveAuthMethodFromAuthType(
  authType:
    | "none"
    | "bearer"
    | "basic"
    | "oauth2"
    | "oauth2_client"
    | "oauth2_private_key"
    | "header"
    | "query"
    | "aws_sigv4",
):
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed"
  | "oauth2_client"
  | "oauth2_private_key"
  | "aws_sigv4" {
  // The two machine-to-machine grants keep their own names: collapsing
  // them into `oauth2_static` would tell a debugger the token came from a
  // user-consented flow when nobody consented to anything.
  if (authType === "oauth2") return "oauth2_static";
  return authType;
}
