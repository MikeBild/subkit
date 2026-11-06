import { absolute, chatNewHref, conversationHref } from "@/app/links";
import type { ConversationSelection } from "@/pages/chat-selection";

export { ChatComposer } from "./composer";
export {
  type AttachmentPreview,
  actionLabel,
  asStreamedDiff,
  catalogHref,
  localizedTarget,
  NO_LIVE_REVIEWS,
  originLine,
  type RestoreComposer,
  type StreamedDiff,
} from "./labels";
export { ChatMessage } from "./message";
export { ModePill, UsagePills } from "./mode";
export { AttachmentPreviewSheet, FollowSubmittedTurn, ReadingColumn } from "./parts";

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
