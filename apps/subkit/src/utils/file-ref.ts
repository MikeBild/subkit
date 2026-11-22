export interface FileRef {
  $file: string;
}

const FID_RE = /^fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isFileRef(v: unknown): v is FileRef {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  const id = obj.$file;
  if (typeof id !== "string") return false;
  return FID_RE.test(id);
}

export function formatFileRef(fid: string): FileRef {
  return { $file: fid };
}

export function parseFileMention(text: string): { fid: string; full: string } | null {
  const m = text.match(/@file:(fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!m) return null;
  return { fid: m[1] as string, full: m[0] };
}

export function parseAllFileMentions(text: string): Array<{ fid: string; full: string }> {
  const out: Array<{ fid: string; full: string }> = [];
  const re = /@file:(fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  for (const m of text.matchAll(re)) {
    out.push({ fid: m[1] as string, full: m[0] });
  }
  return out;
}

export function walkFileRefs(value: unknown, visitor: (ref: FileRef) => void): void {
  if (isFileRef(value)) {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkFileRefs(item, visitor);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      walkFileRefs(v, visitor);
    }
  }
}

export function collectFileRefs(value: unknown): string[] {
  const out: string[] = [];
  walkFileRefs(value, (ref) => out.push(ref.$file));
  return out;
}
