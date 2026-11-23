export type AnswerSourceKind = "knowledge" | "skill" | "docs";

export interface AnswerSource {
  key: string;
  kind: AnswerSourceKind;
  label: string | null;
  path: string | null;
}

export interface AnswerSources {
  shown: AnswerSource[];
  more: number;
}

const SHOWN_SOURCES = 5;

const KIND_BY_TYPE: Readonly<Record<string, AnswerSourceKind>> = {
  knowledge_chunk: "knowledge",
  knowledge_source: "knowledge",
  skill: "skill",
  connector_doc: "docs",
  product_doc: "docs",
};

function sourcePath(type: string, id: string): string | null {
  if (type === "knowledge_source") return `/knowledge/${encodeURIComponent(id)}`;
  if (type === "skill") return `/skills/${encodeURIComponent(id)}`;
  return null;
}

export function answerSources(message: unknown): AnswerSources {
  const citations = (message as { citations?: unknown } | null)?.citations;
  if (!Array.isArray(citations)) return { shown: [], more: 0 };
  const byKey = new Map<string, AnswerSource>();
  for (const citation of citations) {
    if (!citation || typeof citation !== "object") continue;
    const record = citation as Record<string, unknown>;
    const type = typeof record.source_type === "string" ? record.source_type : "";
    const kind = KIND_BY_TYPE[type];
    if (!kind || typeof record.id !== "string" || record.id.length === 0) continue;
    const name = typeof record.source_name === "string" ? record.source_name.trim() : "";
    const key = name ? `${kind}:${name.toLowerCase()}` : `${type}:${record.id}`;
    const path = sourcePath(type, record.id);
    const known = byKey.get(key);
    if (known) {
      if (!known.path && path) known.path = path;
      continue;
    }
    byKey.set(key, { key, kind, label: name || null, path });
  }
  const all = [...byKey.values()];
  return { shown: all.slice(0, SHOWN_SOURCES), more: Math.max(0, all.length - SHOWN_SOURCES) };
}
