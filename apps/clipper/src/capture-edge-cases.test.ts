import { expect, spyOn, test } from "bun:test";
import Defuddle from "defuddle/full";
import { JSDOM } from "jsdom";
import { capture } from "./capture.ts";

const videoUrl = "https://www.youtube.com/watch?v=current-video";
const player = {
  videoDetails: {
    videoId: "current-video",
    title: "Current video",
    author: "Current author",
    shortDescription: "Relevant description.",
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [{ languageCode: "ar" }, { languageCode: "de" }, { languageCode: "en" }],
      audioTracks: [{ audioTrackId: "de.10", defaultCaptionTrackIndex: 1 }],
      defaultAudioTrackIndex: 0,
    },
  },
  streamingData: {
    adaptiveFormats: [
      { audioTrack: { id: "de.10", isAutoDubbed: true, audioIsDefault: true } },
      { audioTrack: { id: "en-US.4" } },
    ],
  },
};
const playerHtml = `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`;

async function withPage(
  html: string,
  url: string,
  action: (dom: JSDOM) => Promise<void>,
): Promise<void> {
  const dom = new JSDOM(html, { url });
  const keys = [
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
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const key of keys) {
    if (key !== "fetch")
      Reflect.set(globalThis, key, key === "window" ? dom.window : Reflect.get(dom.window, key));
  }
  try {
    await action(dom);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function htmlResponse(body: string, url: string): Response {
  const response = new Response(body, { headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("navigation-only pages do not become article content", async () => {
  await withPage(
    "<title>Menu</title><nav><a href='/other'>Navigation debris</a></nav><aside>Recommendation debris</aside>",
    "https://example.test/empty",
    async () => {
      const clip = await capture("article");
      expect(clip.body).toBe("");
      expect(clip.diagnostics).toContainEqual({ code: "main_content_unavailable" });
    },
  );
});

test("landing pages without article markup retain cleaned content", async () => {
  await withPage(
    "<title>People operations</title><nav><a href='/product'>Navigation debris</a></nav><h1>People operations that move with your team</h1><p>Bring performance, learning, and employee data into one place so teams can make better decisions with less administrative work.</p><h2>Context for managers</h2><p>Managers keep the context they need for every conversation and can support their teams with structured feedback and practical guidance.</p><footer>Footer debris</footer>",
    "https://example.test/product",
    async () => {
      const extracted = new Defuddle(document.cloneNode(true) as Document, {
        url: location.href,
        useAsync: false,
      }).parse();
      expect(extracted.content).toMatch(/^<body(?:\s|>)/i);
      const clip = await capture("article");
      expect(clip.body).toContain("less administrative work");
      expect(clip.body).toContain("structured feedback");
      expect(clip.body).not.toContain("Navigation debris");
      expect(clip.body).not.toContain("Footer debris");
      expect(clip.diagnostics).toBeUndefined();
    },
  );
});

test("cleaned body-root output preserves useful linked content", async () => {
  const parse = spyOn(Defuddle.prototype, "parse").mockReturnValue({
    content:
      "<body><h2>Research resources</h2><p>These resources explain the approaches and give practical examples for the team.</p><ul><li><a href='/guide'>Practical guide</a> with worked examples</li><li><a href='/research'>Original research</a> with supporting data</li></ul><p><a href='/manual'>Complete manual</a></p></body>",
    title: "Research resources",
  } as never);
  try {
    await withPage("<title>Research resources</title>", "https://example.test/", async () => {
      const clip = await capture("article");
      expect(clip.body).toContain("Research resources");
      expect(clip.body).toContain("worked examples");
      expect(clip.body).toContain("supporting data");
      expect(clip.body).toContain("Complete manual");
      expect(clip.body).toContain("https://example.test/manual");
    });
  } finally {
    parse.mockRestore();
  }
});

test("unavailable captions retain the description and report their absence", async () => {
  const unavailable = { videoDetails: player.videoDetails };
  await withPage(
    `<script>var ytInitialPlayerResponse=${JSON.stringify(unavailable)};</script>`,
    videoUrl,
    async () => {
      const clip = await capture("article");
      expect(clip.sections?.description).toBe("Relevant description.");
      expect(clip.sections?.transcript).toBeUndefined();
      expect(clip.diagnostics).toContainEqual({ code: "youtube_transcript_unavailable" });
    },
  );
});

test("matching video metadata never fills missing fields from stale page tags", async () => {
  const current = {
    videoDetails: {
      videoId: "current-video",
      title: "Current video",
      shortDescription: "Current description",
    },
  };
  await withPage(
    `<meta name="author" content="Stale author"><meta itemprop="datePublished" content="Stale date"><script>var ytInitialPlayerResponse=${JSON.stringify(current)};</script>`,
    videoUrl,
    async () => {
      const clip = await capture("article");
      expect(clip.metadata.title).toBe("Current video");
      expect(clip.metadata.author).toBeUndefined();
      expect(clip.metadata.publishedAt).toBeUndefined();
    },
  );
});

test("transcript failure retains the video description", async () => {
  const parse = spyOn(Defuddle.prototype, "parseAsync").mockRejectedValue(
    new Error("Captions failed"),
  );
  try {
    await withPage(playerHtml, videoUrl, async () => {
      const clip = await capture("article");
      expect(clip.sections?.description).toBe("Relevant description.");
      expect(clip.diagnostics).toContainEqual({ code: "youtube_transcript_failed" });
    });
  } finally {
    parse.mockRestore();
  }
});

test("SPA capture fetches matching player data before selecting the original transcript language", async () => {
  let requestedLanguage: string | undefined;
  const parse = spyOn(Defuddle.prototype, "parseAsync").mockImplementation(async function (
    this: InstanceType<typeof Defuddle>,
  ) {
    requestedLanguage = (this as unknown as { options: { language?: string } }).options.language;
    return { ...this.parse(), variables: { transcript: "Original spoken text.", language: "en" } };
  });
  try {
    const old = {
      ...player,
      videoDetails: { ...player.videoDetails, videoId: "old-video", title: "Old video" },
    };
    const staleHtml = `<script>var ytInitialPlayerResponse=${JSON.stringify(old)}; var recommended={"videoId":"current-video"};</script>`;
    await withPage(staleHtml, videoUrl, async () => {
      Reflect.set(globalThis, "fetch", async () => htmlResponse(playerHtml, videoUrl));
      const clip = await capture("article");
      expect(requestedLanguage).toBe("en");
      expect(clip.metadata.title).toBe("Current video");
      expect(clip.sections?.transcriptLanguage).toBe("en");
      expect(clip.sections?.transcript).toBe("Original spoken text.");
      expect(clip.body).not.toContain("Old video");
    });
  } finally {
    parse.mockRestore();
  }
});

test("transcripts from another language are not mislabeled as the original", async () => {
  const parse = spyOn(Defuddle.prototype, "parseAsync").mockImplementation(async function (
    this: InstanceType<typeof Defuddle>,
  ) {
    return {
      ...this.parse(),
      variables: { transcript: "Unexpected translated text", language: "ar" },
    };
  });
  try {
    await withPage(playerHtml, videoUrl, async () => {
      const clip = await capture("article");
      expect(clip.sections?.transcript).toBeUndefined();
      expect(clip.body).not.toContain("Unexpected translated text");
      expect(clip.diagnostics).toContainEqual({ code: "youtube_transcript_failed" });
    });
  } finally {
    parse.mockRestore();
  }
});

test("navigation during transcript extraction rejects the stale result", async () => {
  let complete: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const parse = spyOn(Defuddle.prototype, "parseAsync").mockImplementation(async function (
    this: InstanceType<typeof Defuddle>,
  ) {
    const result = this.parse();
    await pending;
    return { ...result, variables: { transcript: "Old source text", language: "en" } };
  });
  try {
    await withPage(playerHtml, videoUrl, async (dom) => {
      const result = capture("article");
      dom.window.history.pushState({}, "", "/watch?v=different-video");
      complete?.();
      await expect(result).rejects.toThrow("page changed");
    });
  } finally {
    complete?.();
    parse.mockRestore();
  }
});

test("a stalled SPA fetch is bounded even if the transport ignores cancellation", async () => {
  await withPage("<title>Unrelated old page</title>", videoUrl, async () => {
    Reflect.set(globalThis, "fetch", () => new Promise<Response>(() => {}));
    const clip = await capture("article");
    expect(clip.body).toBe("");
    expect(clip.metadata.title).not.toBe("Unrelated old page");
    expect(clip.diagnostics).toContainEqual({ code: "main_content_unavailable" });
  });
}, 9_500);

test("invalid metadata is skipped without parser errors or live DOM changes", async () => {
  const errors = spyOn(console, "error");
  try {
    await withPage(
      '<title>Useful page</title><meta name="author" content="Ada"><script type="application/ld+json">{"name":"One"} {"name":"Two"}</script><script type="application/ld+json">null</script><article><h1>Useful page</h1><p>Useful article content remains available despite broken page metadata.</p></article>',
      "https://example.test/article",
      async () => {
        const original = document.documentElement.outerHTML;
        const clip = await capture("article");
        expect(clip.body).toContain("Useful article content");
        expect(clip.metadata.author).toBe("Ada");
        expect(clip.diagnostics).toEqual([{ code: "metadata_unavailable" }]);
        expect(document.documentElement.outerHTML).toBe(original);
        expect(errors).not.toHaveBeenCalled();
      },
    );
  } finally {
    errors.mockRestore();
  }
});

test("article parser failures offer cleaned text with an explicit diagnostic", async () => {
  const parse = spyOn(Defuddle.prototype, "parse").mockImplementation(() => {
    throw new Error("Parser failed");
  });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await withPage(
      "<title>Useful page</title><nav>Navigation debris</nav><main><p>First useful paragraph.</p><p>Second useful paragraph.</p><script>privateScript()</script><form>Private form contents</form><div hidden>Hidden debris</div></main><footer>Footer debris</footer>",
      "https://example.test/article",
      async () => {
        const clip = await capture("article");
        expect(clip.body).toBe("First useful paragraph.\n\nSecond useful paragraph.");
        expect(clip.diagnostics).toEqual([{ code: "article_fallback" }]);
        expect(errors).toHaveBeenCalledTimes(1);
      },
    );
  } finally {
    parse.mockRestore();
    errors.mockRestore();
  }
});

test("empty parser output uses the text fallback and empty pages stay unavailable", async () => {
  const parse = spyOn(Defuddle.prototype, "parse").mockReturnValue({ content: "" } as never);
  try {
    await withPage(
      "<main><p>Useful fallback content.</p></main>",
      "https://example.test/article",
      async () => {
        const clip = await capture("article");
        expect(clip.body).toContain("Useful fallback content.");
        expect(clip.diagnostics).toEqual([{ code: "article_fallback" }]);
      },
    );
    await withPage("<nav>Menu only</nav>", "https://example.test/empty", async () => {
      const clip = await capture("article");
      expect(clip.body).toBe("");
      expect(clip.diagnostics).toEqual([{ code: "main_content_unavailable" }]);
    });
  } finally {
    parse.mockRestore();
  }
});

test("concurrent article captures share extraction and later captures run again", async () => {
  const parse = spyOn(Defuddle.prototype, "parseAsync").mockImplementation(async function (
    this: InstanceType<typeof Defuddle>,
  ) {
    return { ...this.parse(), variables: { transcript: "Original text.", language: "en" } };
  });
  try {
    await withPage(playerHtml, videoUrl, async () => {
      const first = capture("article");
      const second = capture("article");
      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(parse).toHaveBeenCalledTimes(1);
      await capture("article");
      expect(parse).toHaveBeenCalledTimes(2);
    });
  } finally {
    parse.mockRestore();
  }
});
