import { absolute, chatNewHref, conversationHref } from "@/app/links";
import type { ConversationSelection } from "../model/selection";

export function selectionFromPath(initialPrompt: string): ConversationSelection {
  if (initialPrompt || window.location.pathname.endsWith("/chat/new")) return { kind: "new" };
  const match = window.location.pathname.match(/\/chat\/([^/?]+)$/);
  return match?.[1]
    ? { kind: "existing", id: decodeURIComponent(match[1]) }
    : { kind: "automatic" };
}

export function setChatPath(id: string | null, replace = false): void {
  const path = absolute(id ? conversationHref(id) : chatNewHref());
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
}
