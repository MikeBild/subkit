export type AuthoringMode = "auto" | "ask" | "plan";

export function storedAuthoringMode(draft: unknown): AuthoringMode | "yolo" | "unset" {
  if (!draft || typeof draft !== "object" || !("session" in draft)) return "unset";
  const session = draft.session;
  if (!session || typeof session !== "object" || !("permission_mode" in session)) return "unset";
  const mode = session.permission_mode;
  return mode === "auto" || mode === "ask" || mode === "plan" || mode === "yolo" ? mode : "unset";
}
