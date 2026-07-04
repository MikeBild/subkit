import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { llmsTxtStrategy } from "./llms-txt.ts";
import { DiscoveryError } from "./types.ts";

// Spy signature covers only the (input, init) subset the strategies use
// — `typeof fetch` would force every mockImplementation to also carry
// `preconnect`.
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchSpy: ReturnType<typeof mock<FetchLike>>;

beforeEach(() => {
  fetchSpy = mock<FetchLike>();
});

// Driver-fetch seam: the code under test reads getDriverFetch(), not
// globalThis — run each body under the seam's explicit wrapper (the
// override must scope the body itself; an enterWith-from-beforeEach
// binding did not propagate into test bodies under bun).
function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

const FULL_MARKDOWN = `# ACME API

The ACME platform exposes a small set of resources for managing widgets,
gadgets, and the workflows that bind them together. Authentication is via
bearer token; rate limits are documented per endpoint.

## Widgets

- \`GET /widgets\` — list widgets, cursor-paginated.
- \`POST /widgets\` — create a widget.

## Gadgets

- \`GET /gadgets\` — list gadgets.
- \`PATCH /gadgets/{id}\` — update a gadget.
`;

const INDEX_MARKDOWN = `# ACME docs index

- [Auth guide](https://docs.acme.example.com/auth.md)
- [Widgets reference](https://docs.acme.example.com/widgets.md)
- [Gadgets reference](https://docs.acme.example.com/gadgets.md)
`;

describe("llmsTxtStrategy", () => {
  seamTest("uses /.well-known/llms-full.txt when present", async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/llms-full.txt")) {
        return Promise.resolve(
          new Response(FULL_MARKDOWN, {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await llmsTxtStrategy.fetch("https://docs.acme.example.com/api", {});

    expect(result.strategy).toBe("llms-txt");
    expect(result.endpoints).toEqual([]);
    expect(typeof result.text_corpus).toBe("string");
    expect(result.text_corpus ?? "").toContain("ACME API");
    expect(result.text_corpus ?? "").toContain("/widgets");
    expect(result.source_url).toBe("https://docs.acme.example.com/.well-known/llms-full.txt");
  });

  seamTest("falls back to llms.txt and fetches index entries in parallel", async () => {
    const calls: string[] = [];
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.endsWith("/.well-known/llms-full.txt")) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url.endsWith("/.well-known/llms.txt")) {
        return Promise.resolve(
          new Response(INDEX_MARKDOWN, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      if (url === "https://docs.acme.example.com/auth.md") {
        return Promise.resolve(
          new Response("# Auth\n\nBearer tokens are passed in the Authorization header.", {
            status: 200,
          }),
        );
      }
      if (url === "https://docs.acme.example.com/widgets.md") {
        return Promise.resolve(
          new Response("# Widgets\n\nList widgets via GET /widgets.", { status: 200 }),
        );
      }
      if (url === "https://docs.acme.example.com/gadgets.md") {
        return Promise.resolve(
          new Response("# Gadgets\n\nUpdate gadgets via PATCH /gadgets/{id}.", { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await llmsTxtStrategy.fetch("https://docs.acme.example.com/api", {});

    expect(result.strategy).toBe("llms-txt");
    expect(result.source_url).toBe("https://docs.acme.example.com/.well-known/llms.txt");
    const corpus = result.text_corpus ?? "";
    expect(corpus).toContain("Bearer tokens");
    expect(corpus).toContain("List widgets");
    expect(corpus).toContain("Update gadgets");
    // All three index entries should have been fetched.
    expect(calls).toContain("https://docs.acme.example.com/auth.md");
    expect(calls).toContain("https://docs.acme.example.com/widgets.md");
    expect(calls).toContain("https://docs.acme.example.com/gadgets.md");
  });

  seamTest("prefers root /llms-full.txt over the .well-known mirror", async () => {
    const calls: string[] = [];
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.endsWith("/llms-full.txt")) {
        return Promise.resolve(
          new Response(FULL_MARKDOWN, {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await llmsTxtStrategy.fetch("https://docs.acme.example.com/api", {});

    // Root is the canonical spec location, probed before /.well-known/.
    expect(result.source_url).toBe("https://docs.acme.example.com/llms-full.txt");
    expect(result.text_corpus ?? "").toContain("ACME API");
    expect(calls[0]).toBe("https://docs.acme.example.com/llms-full.txt");
  });

  seamTest("uses root /llms.txt when it is the only file present", async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Only the root index exists; both -full variants and the
      // .well-known mirror 404.
      if (url === "https://docs.acme.example.com/llms.txt") {
        return Promise.resolve(
          new Response(FULL_MARKDOWN, {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const result = await llmsTxtStrategy.fetch("https://docs.acme.example.com/api", {});

    expect(result.source_url).toBe("https://docs.acme.example.com/llms.txt");
    expect(result.text_corpus ?? "").toContain("ACME API");
  });

  seamTest("throws spec_not_found when every candidate path 404s", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));

    let caught: DiscoveryError | null = null;
    try {
      await llmsTxtStrategy.fetch("https://docs.acme.example.com/api", {});
    } catch (e) {
      if (e instanceof DiscoveryError) caught = e;
    }
    expect(caught?.code).toBe("spec_not_found");
  });
});
