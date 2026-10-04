import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import { getConfig } from "../../config/loader.ts";
import { redact } from "../../logging/redact.ts";
import type {
  MarkdownOutput,
  ReadabilityOutput,
  StructuredDataOutput,
  TransformStep,
} from "../../workflows/types.ts";
import { validateAgainstJsonSchema } from "../engine/envelope.ts";
import type { StepResult, StepRunContext } from "../types.ts";

function safeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const scrubbed = redact(raw);
  return typeof scrubbed === "string" ? scrubbed : raw;
}

export interface RunWebScraperParams {
  ctx: StepRunContext;
  step: TransformStep;
  input: unknown;
}

function extractHtmlAndUrl(input: unknown): { html: string | null; url: string } {
  if (typeof input === "string") return { html: input, url: "" };
  if (!input || typeof input !== "object") return { html: null, url: "" };
  const obj = input as Record<string, unknown>;
  const url = typeof obj.url === "string" ? obj.url : "";
  if (typeof obj.content_html === "string") return { html: obj.content_html, url };
  if (typeof obj.html === "string") return { html: obj.html, url };
  if (typeof obj.body === "string") return { html: obj.body, url };
  if (obj.body && typeof obj.body === "object") {
    try {
      return { html: JSON.stringify(obj.body), url };
    } catch {
      return { html: null, url };
    }
  }
  return { html: null, url };
}

function fail(start: number, code: string, message: string): StepResult {
  return {
    status: "failed",
    error: { code, message },
    retry_count: 0,
    duration_ms: Date.now() - start,
  };
}

function succeed(start: number, output: unknown): StepResult {
  return {
    status: "succeeded",
    output,
    retry_count: 0,
    duration_ms: Date.now() - start,
  };
}

function maybeValidateEnvelope(
  step: TransformStep,
  envelope: unknown,
  start: number,
): StepResult | null {
  if (!step.output_schema) return null;
  const check = validateAgainstJsonSchema(envelope, step.output_schema, "$output");
  if (check.valid) return null;
  return fail(start, "output_schema_violation", check.errors.join("; "));
}

export function runReadability(p: RunWebScraperParams): StepResult {
  const start = Date.now();
  const cfg = getConfig(p.ctx.tenant_id).connectors.web_scraper;
  const maxChars = p.step.readability?.max_chars ?? cfg.runtime.max_chars_readability;

  const { html, url } = extractHtmlAndUrl(p.input);
  if (html === null) {
    return fail(start, "transform_error", "readability: input did not contain html/body/string");
  }
  if (html.length > maxChars) {
    return fail(
      start,
      "extract_too_large",
      `readability: input html length ${html.length} exceeds max_chars ${maxChars}`,
    );
  }

  let parsed: ReturnType<Readability["parse"]> | null = null;
  try {
    const dom = new JSDOM(html, { url: url || undefined });
    const reader = new Readability(dom.window.document);
    parsed = reader.parse();
  } catch (e) {
    return fail(start, "transform_error", `readability: failed to parse — ${safeErrorMessage(e)}`);
  }
  if (!parsed?.content) {
    return fail(start, "readability_no_article", "readability: no article content detected");
  }

  const envelope: ReadabilityOutput = {
    title: parsed.title ?? null,
    byline: parsed.byline ?? null,
    excerpt: parsed.excerpt ?? null,
    lang: parsed.lang ?? null,
    site_name: parsed.siteName ?? null,
    published_at: parsed.publishedTime ?? null,
    content_html: parsed.content,
    length: parsed.length ?? parsed.content.length,
    url,
  };

  const lengthGuard = p.step.readability?.length_guard;
  if (lengthGuard !== undefined && envelope.length > lengthGuard) {
    return fail(
      start,
      "extract_too_large",
      `readability: extracted length ${envelope.length} exceeds length_guard ${lengthGuard}`,
    );
  }

  return maybeValidateEnvelope(p.step, envelope, start) ?? succeed(start, envelope);
}

const HTML_DROP_TAGS = ["script", "style", "noscript", "iframe", "object", "embed"];

export function runHtmlToMarkdown(p: RunWebScraperParams): StepResult {
  const start = Date.now();
  const cfg = getConfig(p.ctx.tenant_id).connectors.web_scraper;
  const maxChars = p.step.markdown?.max_chars ?? cfg.runtime.max_chars_markdown;
  const preserveLinks = p.step.markdown?.preserve_links ?? true;
  const extraStripTags = p.step.markdown?.strip_tags ?? [];
  const truncate = p.step.markdown?.truncate ?? false;

  const { html, url } = extractHtmlAndUrl(p.input);
  if (html === null) {
    return fail(
      start,
      "transform_error",
      "html-to-markdown: input did not contain html/body/string",
    );
  }

  let dom: JSDOM;
  try {
    dom = new JSDOM(html);
  } catch (e) {
    return fail(
      start,
      "transform_error",
      `html-to-markdown: jsdom parse failed — ${safeErrorMessage(e)}`,
    );
  }

  const stripped: string[] = [];
  for (const tag of [...HTML_DROP_TAGS, ...extraStripTags]) {
    const nodes = dom.window.document.querySelectorAll(tag);
    if (nodes.length > 0) {
      nodes.forEach((n) => {
        n.parentNode?.removeChild(n);
      });
      stripped.push(tag);
    }
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    linkStyle: preserveLinks ? "inlined" : "referenced",
    bulletListMarker: "-",
  });
  if (!preserveLinks) {
    turndown.addRule("noLinks", {
      filter: "a",
      replacement: (content: string): string => content,
    });
  }

  let markdown: string;
  try {
    markdown = turndown.turndown(dom.window.document.body.innerHTML);
  } catch (e) {
    return fail(
      start,
      "transform_error",
      `html-to-markdown: turndown failed — ${safeErrorMessage(e)}`,
    );
  }

  let truncated = false;
  if (markdown.length > maxChars) {
    if (!truncate) {
      return fail(
        start,
        "extract_too_large",
        `html-to-markdown: output length ${markdown.length} exceeds max_chars ${maxChars}`,
      );
    }
    markdown = markdown.slice(0, maxChars);
    truncated = true;
  }

  const envelope: MarkdownOutput = {
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    url,
    truncated,
    stripped_elements: stripped,
  };

  return maybeValidateEnvelope(p.step, envelope, start) ?? succeed(start, envelope);
}

export function runStructuredData(p: RunWebScraperParams): StepResult {
  const start = Date.now();
  const requestedTypes = new Set(
    p.step.structured_data?.types ?? ["json-ld", "opengraph", "microdata"],
  );

  const { html, url } = extractHtmlAndUrl(p.input);
  if (html === null) {
    return fail(
      start,
      "transform_error",
      "structured-data: input did not contain html/body/string",
    );
  }

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: url || undefined });
  } catch (e) {
    return fail(
      start,
      "transform_error",
      `structured-data: jsdom parse failed — ${safeErrorMessage(e)}`,
    );
  }
  const doc = dom.window.document;

  const json_ld: Array<Record<string, unknown>> = [];
  if (requestedTypes.has("json-ld")) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach((s) => {
      const text = s.textContent ?? "";
      if (!text.trim()) return;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === "object") json_ld.push(item as Record<string, unknown>);
          }
        } else if (parsed && typeof parsed === "object") {
          json_ld.push(parsed as Record<string, unknown>);
        }
      } catch {}
    });
  }

  const opengraph: Record<string, string> = {};
  if (requestedTypes.has("opengraph")) {
    const metas = doc.querySelectorAll('meta[property^="og:"], meta[property^="article:"]');
    metas.forEach((m) => {
      const property = m.getAttribute("property");
      const content = m.getAttribute("content");
      if (property && content) opengraph[property] = content;
    });
  }

  const microdata: Array<Record<string, unknown>> = [];
  if (requestedTypes.has("microdata")) {
    const items = doc.querySelectorAll("[itemscope]");
    items.forEach((item) => {
      const obj: Record<string, unknown> = {};
      const itemtype = item.getAttribute("itemtype");
      if (itemtype) obj["@type"] = itemtype;
      const props = item.querySelectorAll("[itemprop]");
      props.forEach((p2) => {
        const name = p2.getAttribute("itemprop");
        if (!name) return;
        const value = p2.getAttribute("content") ?? p2.textContent ?? "";
        obj[name] = value.trim();
      });
      microdata.push(obj);
    });
  }

  const found_any = json_ld.length > 0 || Object.keys(opengraph).length > 0 || microdata.length > 0;

  if (!found_any && p.step.structured_data?.types !== undefined) {
    return fail(
      start,
      "structured_data_not_found",
      `structured-data: none of [${[...requestedTypes].join(", ")}] found on page`,
    );
  }

  const envelope: StructuredDataOutput = {
    json_ld,
    opengraph,
    microdata,
    url,
    found_any,
  };

  return maybeValidateEnvelope(p.step, envelope, start) ?? succeed(start, envelope);
}
