const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function firstGrapheme(text: string): string {
  if (text.length === 0) return "";
  if (segmenter) {
    const iter = segmenter.segment(text)[Symbol.iterator]();
    const next = iter.next();
    if (!next.done) return next.value.segment;
  }
  return text.charAt(0);
}
