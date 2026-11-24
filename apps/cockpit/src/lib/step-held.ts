export function stepWasHeld(step: { held?: boolean; request_meta?: unknown }): boolean {
  if (step.held === true) return true;
  const meta = step.request_meta;
  if (!meta || typeof meta !== "object" || !("extras" in meta)) return false;
  const extras = meta.extras;
  return Boolean(extras && typeof extras === "object" && "held" in extras && extras.held === true);
}
