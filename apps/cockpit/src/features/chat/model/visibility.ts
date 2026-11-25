export type ConversationVisibility = "private" | "team";
export type VisibilityAction = "share" | "unshare";

export function conversationVisibility(
  conversation: { readonly id: string; readonly visibility?: string | null } | null | undefined,
): ConversationVisibility {
  return conversation?.visibility === "team" ? "team" : "private";
}

export function isContentHidden(conversation: {
  readonly id: string;
  readonly content_hidden?: boolean | null;
}): boolean {
  return conversation.content_hidden === true;
}

export function visibilityActionFor(visibility: ConversationVisibility): VisibilityAction {
  return visibility === "team" ? "unshare" : "share";
}

export interface VisibilityTarget {
  readonly id: string;
  readonly title: string;
  readonly action: VisibilityAction;
}

export type VisibilityState =
  | { readonly phase: "idle" }
  | { readonly phase: "confirming"; readonly target: VisibilityTarget }
  | { readonly phase: "saving"; readonly target: VisibilityTarget }
  | {
      readonly phase: "done";
      readonly target: VisibilityTarget;
      readonly visibility: ConversationVisibility;
    }
  | { readonly phase: "error"; readonly target: VisibilityTarget };

export type VisibilityEvent =
  | { readonly type: "ask"; readonly target: VisibilityTarget }
  | { readonly type: "cancel" }
  | { readonly type: "confirm" }
  | { readonly type: "saved"; readonly visibility: ConversationVisibility }
  | { readonly type: "failed" };

export const VISIBILITY_IDLE: VisibilityState = { phase: "idle" };

export function visibilityReducer(state: VisibilityState, event: VisibilityEvent): VisibilityState {
  switch (event.type) {
    case "ask":
      return state.phase === "saving" ? state : { phase: "confirming", target: event.target };
    case "cancel":
      return state.phase === "saving" ? state : VISIBILITY_IDLE;
    case "confirm":
      return state.phase === "confirming" || state.phase === "error"
        ? { phase: "saving", target: state.target }
        : state;
    case "saved":
      return state.phase === "saving"
        ? { phase: "done", target: state.target, visibility: event.visibility }
        : state;
    case "failed":
      return state.phase === "saving" ? { phase: "error", target: state.target } : state;
  }
}

export function visibilityDialogOpen(state: VisibilityState): boolean {
  return state.phase === "confirming" || state.phase === "saving" || state.phase === "error";
}
