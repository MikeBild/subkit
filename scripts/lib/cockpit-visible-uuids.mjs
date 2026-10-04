export const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function textOutsidePayloads(root) {
  const clone = root.cloneNode(true);
  for (const block of [...clone.querySelectorAll("pre, script, style, template")]) block.remove();
  return clone.textContent ?? "";
}

export function findVisibleUuids(text) {
  const found = new Map();
  for (const match of text.matchAll(UUID_SHAPE)) {
    const value = match[0].toLowerCase();
    if (found.has(value)) continue;
    const at = match.index ?? 0;
    found.set(value, {
      value: match[0],
      context: text
        .slice(Math.max(0, at - 40), at + match[0].length + 20)
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return [...found.values()];
}

export async function assertNoVisibleUuids(target, label) {
  const text = await target.evaluate(textOutsidePayloads);
  const found = findVisibleUuids(text);
  if (found.length > 0)
    throw new Error(
      `${label} exposes ${found.length} UUID(s): ${found
        .slice(0, 3)
        .map((entry) => `…${entry.context}…`)
        .join(" | ")}`,
    );
}
