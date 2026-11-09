export function shortIdentifier(value: string): string {
  const looksLikeAnId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
  return looksLikeAnId ? `${value.slice(0, 8)}…` : value;
}
