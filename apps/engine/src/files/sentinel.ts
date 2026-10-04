export const FILE_SENTINEL_RE =
  /\[file:(fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g;

export function extractFileSentinels(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(FILE_SENTINEL_RE.source, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const fid = m[1];
    if (fid && !out.includes(fid)) out.push(fid);
  }
  return out;
}

export function replaceFileSentinels(
  text: string,
  replacer: (fid: string) => string | Promise<string>,
): string | Promise<string> {
  const re = new RegExp(FILE_SENTINEL_RE.source, "g");
  const segments: Array<string | Promise<string>> = [];
  let lastIndex = 0;
  let anyAsync = false;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    segments.push(text.slice(lastIndex, m.index));
    const fid = m[1] ?? "";
    const replaced = replacer(fid);
    if (typeof replaced !== "string") anyAsync = true;
    segments.push(replaced);
    lastIndex = m.index + m[0].length;
  }
  segments.push(text.slice(lastIndex));
  if (!anyAsync) return segments.join("");
  return Promise.all(segments).then((parts) => parts.join(""));
}

export function stripFileSentinelsForDisplay(text: string): string {
  return text.replace(new RegExp(FILE_SENTINEL_RE.source, "g"), "[file]");
}
