import Defuddle, { createMarkdownContent } from "defuddle/full";
import { fallbackArticleText, prepareCaptureDocument } from "./capture-document.ts";
import { chromeApi } from "./chrome-api.ts";
import type { CaptureDiagnostic, CapturedClip, CaptureMode, ClipMetadata } from "./types.ts";

const asyncExtractionTimeoutMs = 8_000;

function meta(root: Document, names: string[]): string | undefined {
  for (const name of names) {
    const element = root.querySelector(
      `meta[name="${name}"], meta[property="${name}"], meta[itemprop="${name}"]`,
    );
    const value = element?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return undefined;
}

function text(element: Element | null): string | undefined {
  const value = (element as HTMLElement | null)?.innerText || element?.textContent;
  const normalized = value
    ?.replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized || undefined;
}

function selectionHtml(): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return undefined;
  const holder = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index += 1) {
    holder.append(selection.getRangeAt(index).cloneContents());
  }
  return holder.innerHTML;
}

function toMarkdown(html: string, sourceUrl: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of parsed.querySelectorAll("[href], [src]")) {
    for (const attribute of ["href", "src"] as const) {
      const value = element.getAttribute(attribute);
      if (!value || value.startsWith("#") || value.startsWith("data:")) continue;
      try {
        element.setAttribute(attribute, new URL(value, sourceUrl).toString());
      } catch {}
    }
  }
  return createMarkdownContent(parsed.body.innerHTML, sourceUrl).trim();
}

function isYoutube(sourceUrl: string): boolean {
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  return hostname === "youtu.be" || hostname.endsWith(".youtube.com") || hostname === "youtube.com";
}

function isYoutubeVideo(sourceUrl: string): boolean {
  if (!isYoutube(sourceUrl)) return false;
  const path = new URL(sourceUrl).pathname;
  return path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/");
}

function isCockpitChat(sourceUrl: string): boolean {
  const url = new URL(sourceUrl);
  return url.pathname.startsWith("/cockpit/chat/");
}

function metadata(
  root: Document,
  sourceUrl: string,
  fallbackTitle?: string,
  values?: { title?: string; author?: string; publishedAt?: string },
): ClipMetadata {
  const title =
    values?.title ||
    text(root.querySelector("h1")) ||
    meta(root, ["og:title", "twitter:title"]) ||
    fallbackTitle ||
    root.title.trim() ||
    new URL(sourceUrl).hostname;
  const author =
    values?.author ||
    text(
      root.querySelector("#channel-name a, #owner #channel-name a, ytd-video-owner-renderer a"),
    ) ||
    meta(root, ["author", "article:author"]);
  const publishedAt =
    values?.publishedAt ||
    meta(root, ["article:published_time", "date", "publishdate", "datePublished"]);
  return {
    title,
    sourceUrl,
    capturedAt: new Date().toISOString(),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function cleanArticle(
  root: Document,
  sourceUrl: string,
): {
  metadata: ClipMetadata;
  body: string;
  diagnostics?: CaptureDiagnostic[];
} {
  if (isCockpitChat(sourceUrl)) {
    const body = fallbackArticleText(root);
    return {
      metadata: metadata(root, sourceUrl),
      body,
      diagnostics: [{ code: body ? "article_fallback" : "main_content_unavailable" }],
    };
  }
  const prepared = prepareCaptureDocument(root);
  const diagnostics: CaptureDiagnostic[] = [];
  if (prepared.metadataSkipped) diagnostics.push({ code: "metadata_unavailable" });
  let result: ReturnType<InstanceType<typeof Defuddle>["parse"]> | undefined;
  let body = "";
  try {
    result = new Defuddle(prepared.document, { url: sourceUrl, useAsync: false }).parse();
    body = toMarkdown(result.content, sourceUrl);
  } catch (error) {
    console.error("Clipper article extraction failed", error);
  }
  if (!body) {
    body = fallbackArticleText(root);
    diagnostics.push({ code: body ? "article_fallback" : "main_content_unavailable" });
  }
  return {
    metadata: metadata(root, sourceUrl, undefined, {
      ...(result?.title ? { title: result.title } : {}),
      ...(result?.author ? { author: result.author } : {}),
      ...(result?.published ? { publishedAt: result.published } : {}),
    }),
    body,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

function youtubeVideoId(sourceUrl: string): string | undefined {
  const url = new URL(sourceUrl);
  if (url.hostname === "youtu.be") return url.pathname.slice(1) || undefined;
  if (url.pathname === "/watch") return url.searchParams.get("v") || undefined;
  return url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
}

function jsonAt(source: string, start: number): string | undefined {
  if (source[start] !== "{") return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

interface YoutubePlayer {
  videoDetails: { videoId?: string; title?: string; author?: string; shortDescription?: string };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{ languageCode?: string; kind?: string }>;
      audioTracks?: Array<{ audioTrackId?: string }>;
      defaultAudioTrackIndex?: number;
    };
  };
  streamingData?: {
    adaptiveFormats?: Array<{
      audioTrack?: {
        id?: string;
        isAutoDubbed?: boolean;
      };
    }>;
  };
}

function youtubePlayer(root: Document, sourceUrl: string): YoutubePlayer | undefined {
  const videoId = youtubeVideoId(sourceUrl);
  if (!videoId) return undefined;
  for (const script of root.querySelectorAll("script")) {
    const source = script.textContent || "";
    const candidates: string[] = [];
    if (script.type === "application/json") candidates.push(source);
    for (const match of source.matchAll(/\bytInitialPlayerResponse(?:["']\])?\s*=\s*/g)) {
      const raw = jsonAt(source, (match.index ?? 0) + match[0].length);
      if (raw) candidates.push(raw);
    }
    for (const raw of candidates) {
      try {
        const player = JSON.parse(raw) as YoutubePlayer;
        if (player?.videoDetails?.videoId === videoId) return player;
      } catch {}
    }
  }
  return undefined;
}

function youtubeTranscriptLanguage(player?: YoutubePlayer): string | undefined {
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const captions = renderer?.captionTracks;
  if (!Array.isArray(captions) || !captions.length) return undefined;
  const formats = player?.streamingData?.adaptiveFormats;
  const original = Array.isArray(formats)
    ? formats.find((format) => format.audioTrack?.id && format.audioTrack.isAutoDubbed !== true)
        ?.audioTrack
    : undefined;
  const audio =
    original?.id || renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? -1]?.audioTrackId;
  const base = audio?.split(".")[0]?.split("-")[0]?.toLowerCase();
  if (base) {
    return captions.find((caption) => caption.languageCode?.split("-")[0]?.toLowerCase() === base)
      ?.languageCode;
  }
  return captions.length === 1 ? captions[0]?.languageCode : undefined;
}

function youtubeDetails(player?: YoutubePlayer): {
  title?: string;
  author?: string;
  publishedAt?: string;
  description?: string;
} {
  const details = player?.videoDetails;
  if (!details) return {};
  const publishedAt = player?.microformat?.playerMicroformatRenderer?.publishDate;
  return {
    ...(typeof details.title === "string" ? { title: details.title } : {}),
    ...(typeof details.author === "string" ? { author: details.author } : {}),
    ...(typeof publishedAt === "string" ? { publishedAt } : {}),
    ...(typeof details.shortDescription === "string"
      ? { description: details.shortDescription }
      : {}),
  };
}

function composeParts(parts: { description?: string; transcript?: string }): string {
  const sections = [
    parts.description ? `## Description\n\n${parts.description}` : undefined,
    parts.transcript ? `## Transcript\n\n${parts.transcript}` : undefined,
  ].filter((section): section is string => Boolean(section));
  return sections.join("\n\n");
}

export function composeCaptureBody(parts: { description?: string; transcript?: string }): string {
  return composeParts(parts);
}

async function fetchYoutubeDocument(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<Document | undefined> {
  const response = await fetch(sourceUrl, { signal });
  if (
    !response.ok ||
    new URL(response.url).origin !== new URL(sourceUrl).origin ||
    youtubeVideoId(response.url) !== youtubeVideoId(sourceUrl)
  )
    return undefined;
  const root = new DOMParser().parseFromString(await response.text(), "text/html");
  return youtubePlayer(root, sourceUrl) ? root : undefined;
}

async function youtubeClip(root: Document, sourceUrl: string): Promise<CapturedClip> {
  const controller = new AbortController();
  let player = youtubePlayer(root, sourceUrl);
  let details = youtubeDetails(player);
  let transcriptLanguage = youtubeTranscriptLanguage(player);
  let transcript: string | undefined;
  let transcriptFailure = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    await Promise.race([
      (async () => {
        let captureRoot = root;
        if (!player) {
          const fetched = await fetchYoutubeDocument(sourceUrl, controller.signal);
          if (!active || !fetched) return;
          captureRoot = fetched;
          player = youtubePlayer(fetched, sourceUrl);
          details = youtubeDetails(player);
          transcriptLanguage = youtubeTranscriptLanguage(player);
        }
        if (!transcriptLanguage) return;
        const boundedFetch: typeof fetch = Object.assign(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            fetch(input, { ...init, signal: controller.signal }),
          { preconnect: fetch.preconnect },
        );
        const result = await new Defuddle(prepareCaptureDocument(captureRoot).document, {
          url: sourceUrl,
          language: transcriptLanguage,
          fetch: boundedFetch,
        }).parseAsync();
        if (!active) return;
        const actualLanguage = result.variables?.language;
        if (
          actualLanguage &&
          actualLanguage.split("-")[0]?.toLowerCase() !==
            transcriptLanguage.split("-")[0]?.toLowerCase()
        ) {
          transcriptFailure = true;
          return;
        }
        transcript = result.variables?.transcript?.replace(/\r\n/g, "\n").trim() || undefined;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          active = false;
          controller.abort();
          reject(new Error("Transcript extraction timed out."));
        }, asyncExtractionTimeoutMs);
      }),
    ]);
  } catch {
    transcriptFailure = true;
  } finally {
    active = false;
    if (timeout) clearTimeout(timeout);
  }
  const sections = {
    ...(details.description ? { description: details.description } : {}),
    ...(transcript ? { transcript } : {}),
    ...(transcriptLanguage ? { transcriptLanguage } : {}),
  };
  const diagnostics: CaptureDiagnostic[] = [];
  if (!transcript)
    diagnostics.push({
      code: transcriptFailure ? "youtube_transcript_failed" : "youtube_transcript_unavailable",
    });
  if (!details.description && !transcript) diagnostics.push({ code: "main_content_unavailable" });
  const capturedMetadata = details.title
    ? {
        title: details.title,
        sourceUrl,
        capturedAt: new Date().toISOString(),
        ...(details.author ? { author: details.author } : {}),
        ...(details.publishedAt ? { publishedAt: details.publishedAt } : {}),
      }
    : {
        title: text(root.querySelector("ytd-watch-metadata h1")) || new URL(sourceUrl).hostname,
        sourceUrl,
        capturedAt: new Date().toISOString(),
      };
  return {
    metadata: capturedMetadata,
    body: composeParts(sections),
    sections,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

async function capturePage(mode: CaptureMode): Promise<CapturedClip> {
  const sourceUrl = location.href;
  const selected = mode !== "article" ? selectionHtml() : undefined;
  if (mode === "selection" && !selected) {
    return {
      metadata: metadata(document, sourceUrl),
      body: "",
      diagnostics: [{ code: "selection_unavailable" }],
    };
  }
  if (selected) {
    const body = toMarkdown(selected, sourceUrl);
    return {
      metadata: metadata(document, sourceUrl),
      body,
    };
  }
  const clip = isYoutubeVideo(sourceUrl)
    ? await youtubeClip(document, sourceUrl)
    : cleanArticle(document, sourceUrl);
  if (location.href !== sourceUrl) throw new Error("The page changed before capture completed.");
  return clip;
}

const pendingArticles = new Map<string, Promise<CapturedClip>>();

export function capture(mode: CaptureMode): Promise<CapturedClip> {
  if (mode !== "article") return capturePage(mode);
  const sourceUrl = location.href;
  const pending = pendingArticles.get(sourceUrl);
  if (pending) return pending;
  const result = capturePage(mode).finally(() => {
    if (pendingArticles.get(sourceUrl) === result) pendingArticles.delete(sourceUrl);
  });
  pendingArticles.set(sourceUrl, result);
  return result;
}

const pageState = globalThis as typeof globalThis & { subkitCaptureHandler?: boolean };

if (!pageState.subkitCaptureHandler && chromeApi?.runtime) {
  pageState.subkitCaptureHandler = true;
  chromeApi.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return undefined;
    const request = message as { type?: string; mode?: CaptureMode };
    if (request.type !== "capture") return undefined;
    return capture(
      request.mode === "selection" ? "selection" : request.mode === "auto" ? "auto" : "article",
    );
  });
}
