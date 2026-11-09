import { workerEmbeddingsAvailable, workerEmbedTexts } from "./worker-client.ts";

export { EMBEDDING_MODEL } from "./local-runtime.ts";

export const embeddingsAvailable = workerEmbeddingsAvailable;
export const embedTexts = workerEmbedTexts;

export async function embedText(text: string): Promise<number[] | null> {
  const [vec] = await embedTexts([text]);
  return vec ?? null;
}

async function embedChunkTexts(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  try {
    const vecs = await embedTexts(texts);
    if (vecs.length === texts.length) return vecs;
  } catch {}
  return texts.map(() => null);
}

const EMBED_SUBBATCH = 1;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function embedChunkTextsPaced(
  texts: string[],
  opts: {
    subBatch?: number;
    embed?: (t: string[]) => Promise<(number[] | null)[]>;
    yield?: () => Promise<void>;
  } = {},
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const subBatch = Math.max(1, opts.subBatch ?? EMBED_SUBBATCH);
  const embed = opts.embed ?? embedChunkTexts;
  const onYield = opts.yield ?? yieldToEventLoop;
  const out: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += subBatch) {
    if (i > 0) await onYield();
    const slice = texts.slice(i, i + subBatch);
    out.push(...(await embed(slice)));
  }
  return out;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
