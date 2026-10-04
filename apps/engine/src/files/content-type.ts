export function isTextLike(content_type: string | null | undefined): boolean {
  if (!content_type) return true;
  return (
    content_type.startsWith("text/") ||
    content_type.includes("json") ||
    content_type.includes("yaml") ||
    content_type.includes("xml") ||
    content_type.includes("x-www-form-urlencoded")
  );
}
