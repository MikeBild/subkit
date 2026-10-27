import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { llmsTxtStrategy } from "./llms-txt.ts";
import { DiscoveryError } from "./types.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchSpy: ReturnType<typeof mock<FetchLike>>;

beforeEach(() => {
  fetchSpy = mock<FetchLike>();
});

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
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
    expect(result.source_url).toBe("https://docs.acme.example.com/api/.well-known/llms-full.txt");
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
    expect(result.source_url).toBe("https://docs.acme.example.com/api/.well-known/llms.txt");
    const corpus = result.text_corpus ?? "";
    expect(corpus).toContain("Bearer tokens");
    expect(corpus).toContain("List widgets");
    expect(corpus).toContain("Update gadgets");
    expect(calls).toContain("https://docs.acme.example.com/auth.md");
    expect(calls).toContain("https://docs.acme.example.com/widgets.md");
    expect(calls).toContain("https://docs.acme.example.com/gadgets.md");
  });

  seamTest("prefers service /llms-full.txt over the .well-known mirror", async () => {
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

    expect(result.source_url).toBe("https://docs.acme.example.com/api/llms-full.txt");
    expect(result.text_corpus ?? "").toContain("ACME API");
    expect(calls[0]).toBe("https://docs.acme.example.com/api/llms-full.txt");
  });

  seamTest("uses root /llms.txt when it is the only file present", async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
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

seamTest(
  "resolves relative docs under the service path without forwarding foreign credentials",
  async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://docs.acme.example.com/support/llms.txt") {
        return new Response(
          "# Docs\n- [Guide](authoring.md)\n- [Skill](/support/skill.md)\n- [External](https://other.example.com/doc.md)",
        );
      }
      if (url.endsWith(".md")) return new Response("Useful documentation");
      return new Response(null, { status: 404 });
    });
    const result = await llmsTxtStrategy.fetch("https://docs.acme.example.com/support", {
      headers: { authorization: "Bearer private" },
    });
    expect(result.source_url).toBe("https://docs.acme.example.com/support/llms.txt");
    expect(
      requests.find((r) => r.url.endsWith("/support/authoring.md"))?.init?.headers,
    ).toMatchObject({ authorization: "Bearer private" });
    expect(
      requests.find((r) => r.url.startsWith("https://other.example.com/"))?.init?.headers,
    ).not.toHaveProperty("authorization");
    expect(requests.every((r) => r.init?.redirect === "error")).toBe(true);
    expect(result.text_corpus).toContain("/support/skill.md");
  },
);

seamTest("stops reading an oversized discovery document at the configured limit", async () => {
  let cancelled = false;
  fetchSpy.mockImplementation(async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream);
  });
  const result = await llmsTxtStrategy.fetch("https://docs.acme.example.com/support", {});
  expect(Buffer.byteLength(result.text_corpus ?? "")).toBeLessThanOrEqual(50 * 1024);
  expect(cancelled).toBe(true);
});
