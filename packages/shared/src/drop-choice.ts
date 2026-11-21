export type DropChoice = "file" | "source" | "chat" | "inbox";
export const DROP_CHOICES: readonly DropChoice[] = ["file", "source", "chat", "inbox"];

export function placedHref(choice: DropChoice, ids: readonly string[]): string {
  if (choice === "chat") return "/chat";
  const list = choice === "file" ? "/files" : choice === "source" ? "/knowledge" : "/intake";
  const [only] = ids;
  return ids.length === 1 && only ? `${list}/${encodeURIComponent(only)}` : list;
}
