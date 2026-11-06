import { absolute, chatNewHref, conversationHref } from "@/app/links";
import type { ConversationSelection } from "@/pages/chat-selection";

export { ChatComposer } from "./composer";
export { ChatComposerArea } from "./composer-area";
export { ChatContextContent } from "./context-content";
export { ChatContextDock, ChatContextSheet, useContextDock } from "./context-dock";
export { ConversationDialogs, useConversationDialogs } from "./conversation-dialogs";
export { ConversationHead, TurnErrors } from "./conversation-head";
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
export { ChatListPanel } from "./list-panel";
export { ChatMessage } from "./message";
export { ModePill, UsagePills } from "./mode";
export { AttachmentPreviewSheet, FollowSubmittedTurn, ReadingColumn } from "./parts";
export { QuestionDock } from "./question-dock";
export { ChatTranscript } from "./transcript";

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
