export function checkRequired(value: unknown, schema: Record<string, unknown>): string[] {
  const required = schema.required as string[] | undefined;
  if (!required || !Array.isArray(required)) return [];
  if (typeof value !== "object" || value === null)
    return required.map((f) => `required field '${f}' is missing`);
  return required
    .filter((f) => !(f in (value as Record<string, unknown>)))
    .map((f) => `required field '${f}' is missing`);
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
    | "aws_sigv4"
    | "signed_jwt",
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
  | "aws_sigv4"
  | "signed_jwt" {
  if (authType === "oauth2") return "oauth2_static";
  return authType;
}
