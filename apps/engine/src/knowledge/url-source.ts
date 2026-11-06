import type { Actor } from "../audit/actor.ts";
import { htmlToMarkdown, looksLikeHtml } from "../connectors/discovery/html-to-markdown.ts";
import { getDriverFetch } from "../connectors/drivers/fetch-seam.ts";
import { fetchWithEgressGuard } from "../connectors/egress-fetch.ts";
import { assertEgressAllowedResolved, EgressBlockedError } from "../connectors/egress-guard.ts";
import type { Executor } from "../db/client.ts";
import { KNOWLEDGE_SOURCE_MAX_BYTES, KnowledgeBudgetExceededError } from "./budgets.ts";
import { createKnowledgeSource, getKnowledgeSource, ingestKnowledgeSource } from "./service.ts";
import type { CreateKnowledgeSourceInput, KnowledgeSourceView } from "./types.ts";

const FETCH_TIMEOUT_MS = 20_000;

export class KnowledgeUrlFetchError extends Error {
  readonly code = "url_fetch_failed";
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "KnowledgeUrlFetchError";
  }
}

export class KnowledgeSourceNotRefreshableError extends Error {
  readonly code = "not_refreshable";
  constructor(public readonly source_type: string) {
    super(`a ${source_type} source has no address to read again`);
    this.name = "KnowledgeSourceNotRefreshableError";
  }
}

export interface FetchedDocument {
  content: string;
  mime: string;
}

export async function fetchUrlDocument(
  url: string,
  tenant_id: string,
  exec?: Executor,
): Promise<FetchedDocument> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new KnowledgeUrlFetchError("only http and https addresses can be read", null);
  try {
    await assertEgressAllowedResolved(parsed, { tenant_id, ...(exec ? { exec } : {}) });
  } catch (error) {
    if (error instanceof EgressBlockedError)
      throw new KnowledgeUrlFetchError(`the address may not be read: ${error.reason}`, null);
    throw error;
  }
  let response: Response;
  try {
    response = await fetchWithEgressGuard(
      parsed,
      {
        redirect: "follow",
        headers: { accept: "text/html, text/markdown, text/plain;q=0.9, */*;q=0.5" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      { tenant_id, ...(exec ? { exec } : {}) },
      { fetchImpl: getDriverFetch() },
    );
  } catch (error) {
    throw new KnowledgeUrlFetchError(
      `the address could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      null,
    );
  }
  if (!response.ok)
    throw new KnowledgeUrlFetchError(`the address answered ${response.status}`, response.status);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > KNOWLEDGE_SOURCE_MAX_BYTES)
    throw new KnowledgeBudgetExceededError(
      `Page exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
      declared,
      KNOWLEDGE_SOURCE_MAX_BYTES,
    );
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !/^(text\/|application\/(json|xhtml\+xml|xml))/.test(contentType))
    throw new KnowledgeUrlFetchError(
      `the address returns ${contentType.split(";")[0]}, not text`,
      null,
    );
  const raw = await response.text();
  const html = contentType.includes("html") || looksLikeHtml(raw);
  const content = html ? htmlToMarkdown(raw) : raw;
  if (!content.trim()) throw new KnowledgeUrlFetchError("the address returned no text", null);
  return { content, mime: html ? "text/markdown" : contentType.split(";")[0] || "text/plain" };
}

export function nameFromUrl(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.host}${path}`.slice(0, 200);
}

export async function createKnowledgeSourceFromUrl(
  p: {
    tenant_id: string;
    actor: Actor | null;
    url: string;
    input: Omit<CreateKnowledgeSourceInput, "name"> & { name?: string | undefined };
  },
  exec: Executor,
): Promise<KnowledgeSourceView> {
  const document = await fetchUrlDocument(p.url, p.tenant_id, exec);
  return createKnowledgeSource(
    {
      tenant_id: p.tenant_id,
      actor: p.actor,
      input: { ...p.input, name: p.input.name?.trim() || nameFromUrl(p.url) },
      upload: {
        buffer: Buffer.from(document.content, "utf8"),
        filename: p.url,
        mime: document.mime,
      },
      source_type_override: "url",
      source_uri_override: p.url,
    },
    exec,
  );
}

export async function refreshKnowledgeSource(
  p: {
    tenant_id: string;
    actor: Actor | null;
    id: string;
  },
  exec: Executor,
): Promise<KnowledgeSourceView | null> {
  const source = await getKnowledgeSource(p.tenant_id, p.id, exec);
  if (!source) return null;
  if (source.source_type !== "url")
    throw new KnowledgeSourceNotRefreshableError(source.source_type);
  const document = await fetchUrlDocument(source.source_uri, p.tenant_id, exec);
  await ingestKnowledgeSource(
    {
      tenant_id: p.tenant_id,
      actor: p.actor,
      knowledge_source_id: p.id,
      expected_source_uri: source.source_uri,
      upload: {
        buffer: Buffer.from(document.content, "utf8"),
        filename: source.source_uri,
        mime: document.mime,
      },
    },
    exec,
  );
  return getKnowledgeSource(p.tenant_id, p.id, exec);
}
