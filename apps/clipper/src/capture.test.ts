import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { capture, composeCaptureBody } from "./capture.ts";

test("capture keeps article content and excludes page navigation", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><title>Clean article</title><meta name="author" content="Ada"></head><body><nav>Navigation debris</nav><article><h1>Clean article</h1><p id="selection">Useful <a href="/relative">article text</a><img src="/image.png"></p><p>Another relevant paragraph.</p></article><aside>Recommendation debris</aside></body></html>',
    { url: "https://example.test/article" },
  );
  const globals = [
    "window",
    "document",
    "location",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLImageElement",
    "DOMParser",
    "NodeFilter",
    "getComputedStyle",
  ] as const;
  const previous = new Map(globals.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    DOMParser: dom.window.DOMParser,
    NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  try {
    const clip = await capture("article");
    expect(clip.metadata.title).toBe("Clean article");
    expect(clip.metadata.author).toBe("Ada");
    expect(clip.body).toContain("Useful [article text]");
    expect(clip.body).not.toContain("Navigation debris");
    expect(clip.body).not.toContain("Recommendation debris");
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#selection") as Node);
    window.getSelection()?.addRange(range);
    const automaticSelection = await capture("auto");
    expect(automaticSelection.body).not.toContain("Another relevant paragraph");
    const selected = await capture("selection");
    expect(selected.body).toContain("https://example.test/relative");
    expect(selected.body).toContain("https://example.test/image.png");
    window.getSelection()?.removeAllRanges();
    const automaticArticle = await capture("auto");
    expect(automaticArticle.body).toContain("Another relevant paragraph");
    const fallback = await capture("selection");
    expect(fallback.body).toBe("");
    expect(fallback.diagnostics).toContainEqual({ code: "selection_unavailable" });
  } finally {
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
    dom.window.close();
  }
});

test("video sections compose without empty headings", () => {
  expect(composeCaptureBody({ description: "Video description" })).toBe(
    "## Description\n\nVideo description",
  );
  expect(composeCaptureBody({ transcript: "Transcript text" })).toBe(
    "## Transcript\n\nTranscript text",
  );
});

test("youtube metadata and description come from the matching player data", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><title>Unrelated recommendation</title></head><body><h1>Unrelated recommendation</h1><script>var oldPlayer={"videoDetails":{"videoId":"old-video","title":"Old video","author":"Old author","shortDescription":"Old description."}};var ytInitialPlayerResponse={"videoDetails":{"videoId":"video-1","title":"Exact video","author":"Exact author","shortDescription":"Only the actual description."},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"languageCode":"ar"},{"languageCode":"en"},{"languageCode":"de"}],"audioTracks":[{"audioTrackId":"ar.1"},{"audioTrackId":"de.2"}],"defaultAudioTrackIndex":1}},"streamingData":{"adaptiveFormats":[{"audioTrack":{"id":"en-US.4","isAutoDubbed":false}},{"audioTrack":{"id":"de.2","isAutoDubbed":true}}]},"microformat":{"playerMicroformatRenderer":{"publishDate":"2025-01-02"}}};</script><div id="description">Unrelated panel contents</div></body></html>',
    { url: "https://www.youtube.com/shorts/video-1" },
  );
  const globals = [
    "window",
    "document",
    "location",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLImageElement",
    "DOMParser",
    "NodeFilter",
    "getComputedStyle",
    "fetch",
  ] as const;
  const previous = new Map(globals.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    DOMParser: dom.window.DOMParser,
    NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    fetch: () => Promise.reject(new Error("network disabled")),
  });
  try {
    const clip = await capture("article");
    expect(clip.metadata.title).toBe("Exact video");
    expect(clip.metadata.author).toBe("Exact author");
    expect(clip.metadata.publishedAt).toBe("2025-01-02");
    expect(clip.sections?.description).toBe("Only the actual description.");
    expect(clip.sections?.transcriptLanguage).toBe("en");
    expect(clip.body).not.toContain("Unrelated panel contents");
  } finally {
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
    dom.window.close();
  }
});
