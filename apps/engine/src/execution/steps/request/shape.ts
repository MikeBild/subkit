export function checkRequired(value: unknown, schema: Record<string, unknown>): string[] {
  const required = schema.required as string[] | undefined;
  if (!required || !Array.isArray(required)) return [];
  if (typeof value !== "object" || value === null)
    return required.map((f) => `required field '${f}' is missing`);
  return required
    .filter((f) => !(f in (value as Record<string, unknown>)))
    .map((f) => `required field '${f}' is missing`);
}

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
  if (authType === "oauth2") return "oauth2_static";
  return authType;
}
