export function isNavShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  typing: boolean;
}): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  if (event.defaultPrevented || event.typing) return false;
  return event.key.toLowerCase() === "b";
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  return (
    el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName ?? "")
  );
}
