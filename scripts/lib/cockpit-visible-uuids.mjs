/**
 * Identifiers where a person reads — found by their SHAPE, not by one value.
 *
 * The sweep used to test `visibleText.includes(uuid)` for the one fixture UUID
 * it knew. Every other identifier passed: an authority card headed by its own
 * UUID, a version id printed raw in monospace — 52 of them on one production
 * workflow page — because none of them happened to be THAT string. A check
 * that knows the answer in advance is a check against the bugs already found.
 *
 * The one exemption is a fenced block (`pre`): there an identifier is not a
 * label but the content — a request body the answer hands over — and masking
 * it hands the reader something that cannot work. Monospace is not the
 * exemption; a bare id in backticks mid-sentence is banned like any other.
 */

/** Any UUID-shaped string, any case, any version nibble. */
// No word boundaries: `textContent` runs adjacent blocks together ("Mehr6f1c…",
// "…6c41Version"), and a boundary there hid exactly the identifiers that sit
// flush against a label.
export const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The text a reader can reach under `root`, minus fenced blocks.
 *
 * Runs IN THE BROWSER (`locator.evaluate(textOutsidePayloads)`), so it must
 * stay self-contained: no imports, no closure. It reads a detached clone, so
 * text in a closed drawer or a screen-reader-only span counts too — hidden is
 * not the same as absent, and a screen reader reads it aloud.
 */
export function textOutsidePayloads(root) {
  const clone = root.cloneNode(true);
  for (const block of [...clone.querySelectorAll("pre, script, style, template")]) block.remove();
  return clone.textContent ?? "";
}

/** Every distinct UUID in `text`, each with a little context for the report. */
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

/** Fail when any UUID is readable under `target` (a Playwright locator). */
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
