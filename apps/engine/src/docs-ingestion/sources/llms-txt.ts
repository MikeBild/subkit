import {
  canConsumeBytes,
  canFetchSpec,
  canFollowLink,
  markBudgetExceeded,
  recordLinkFollowed,
} from "../budgets.ts";
import { readBoundedText } from "../read-response.ts";
import type { BudgetState, RawChunk } from "../types.ts";
import { ingestMarkdown } from "./markdown.ts";
import { ingestOpenAPIUrl } from "./openapi.ts";

export interface LlmsTxtIngestResult {
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
  followed: number;
}

export function parseLlmsTxt(body: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const [, title, url] = m;
    if (title && url) out.push({ title: title.trim(), url });
  }
  return out;
}

export async function ingestLlmsTxt(
  url: string,
  state: BudgetState,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmsTxtIngestResult> {
  const res = await fetchImpl(url, { headers: { accept: "text/plain,text/markdown,*/*" } });
  if (!res.ok) throw new Error(`llms.txt fetch failed: ${res.status}`);
  const body = await readBoundedText(res);
  const bytes = Buffer.byteLength(body, "utf8");
  if (!canConsumeBytes(state, bytes)) {
    markBudgetExceeded(state);
    return { uri: url, raw_bytes: 0, chunks: [], followed: 0 };
  }

  const indexChunk: RawChunk = {
    title: "llms.txt index",
    path: "llms.txt",
    content: body,
  };
  const chunks: RawChunk[] = [indexChunk];

  const links = parseLlmsTxt(body);
  let followed = 0;
  for (const link of links) {
    if (!canFollowLink(state)) break;
    if (!canFetchSpec(state)) break;
    if (state.budget_exceeded) break;
    try {
      if (/\.(json|yaml|yml)(\?|$)/i.test(link.url)) {
        const got = await ingestOpenAPIUrl(link.url, state, fetchImpl);
        for (const c of got.chunks) {
          chunks.push({
            title: `${link.title}: ${c.title ?? ""}`.trim(),
            path: c.path ?? null,
            content: c.content,
          });
        }
      } else {
        const got = await ingestMarkdown({ url: link.url }, state, fetchImpl);
        for (const c of got.chunks) {
          chunks.push({
            title: `${link.title}: ${c.title ?? ""}`.trim(),
            path: c.path ?? null,
            content: c.content,
          });
        }
      }
      recordLinkFollowed(state);
      followed += 1;
    } catch (_err) {}
  }

  return { uri: url, raw_bytes: bytes, chunks, followed };
}
