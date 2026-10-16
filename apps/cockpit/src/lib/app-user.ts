const PLACEHOLDER_DOMAIN = "@invalid";

export function isAppUserEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(PLACEHOLDER_DOMAIN);
}

export function appUserProvider(
  email: string | null | undefined,
  identities: readonly { provider_id: string }[] = [],
): string | null {
  if (!isAppUserEmail(email)) return null;
  const local = (email as string).slice(0, -PLACEHOLDER_DOMAIN.length);
  const colon = local.indexOf(":");
  if (colon > 0) return local.slice(0, colon);
  return identities[0]?.provider_id ?? "";
}
