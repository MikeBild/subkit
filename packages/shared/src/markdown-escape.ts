export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/[\\|]/g, "\\$&").replace(/\s+/g, " ").trim();
}

export function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&");
}
