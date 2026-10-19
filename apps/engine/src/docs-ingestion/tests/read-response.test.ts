import { expect, test } from "bun:test";
import { createBudgetState, PageTooLargeError, PER_PAGE_BYTES } from "../budgets.ts";
import { cascadeIngest, discoverOpenApiLinks } from "../cascade.ts";
import { readBoundedText } from "../read-response.ts";
import { fetchGoogleDiscovery } from "../sources/google-discovery.ts";
import { fetchIntrospection } from "../sources/graphql.ts";
import { ingestLlmsTxt } from "../sources/llms-txt.ts";
import { fetchMarkdown } from "../sources/markdown.ts";
import { fetchOpenAPI, ingestOpenAPIUrl } from "../sources/openapi.ts";

function endlessResponse(headers?: HeadersInit) {
  let pulls = 0;
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        canceled = true;
      },
    }),
    headers ? { headers } : {},
  );
  return { response, pulls: () => pulls, canceled: () => canceled };
}
function responseFetch(respond: (url: string) => Response): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0]) => respond(String(input)), {
    preconnect: () => {},
  }) as typeof fetch;
}

test("chunked responses stop and cancel as soon as the wire byte limit is exceeded", async () => {
  const stream = endlessResponse();
  await expect(readBoundedText(stream.response, 100_000)).rejects.toBeInstanceOf(PageTooLargeError);
  expect(stream.canceled()).toBe(true);
  expect(stream.pulls()).toBeLessThanOrEqual(3);
  expect(stream.response.body?.locked).toBe(false);
});

test("declared oversize cancels before reader acquisition and understated lengths cannot bypass the cap", async () => {
  for (const length of ["99999999999999999999999999999999999", "1"]) {
    const stream = endlessResponse({ "content-length": length });
    await expect(readBoundedText(stream.response, 100_000)).rejects.toBeInstanceOf(
      PageTooLargeError,
    );
    expect(stream.canceled()).toBe(true);
    expect(stream.pulls()).toBeLessThanOrEqual(length === "1" ? 3 : 1);
  }
});

test("UTF8 splits and exact boundaries retain text while replacement expansion remains bounded", async () => {
  const encoded = new TextEncoder().encode("😀a");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 2));
        controller.enqueue(encoded.subarray(2));
        controller.close();
      },
    }),
  );
  expect(await readBoundedText(response, 5)).toBe("😀a");
  await expect(readBoundedText(new Response("ééé"), 5)).rejects.toBeInstanceOf(PageTooLargeError);
  await expect(readBoundedText(new Response(new Uint8Array([255])), 1)).rejects.toBeInstanceOf(
    PageTooLargeError,
  );
  expect(await readBoundedText(new Response(null), 0)).toBe("");
});

test("upstream stream failures cancel and release the reader without swallowing the failure", async () => {
  const error = new Error("stream_failed");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(error);
      },
    }),
  );
  await expect(readBoundedText(response)).rejects.toBe(error);
  expect(response.body?.locked).toBe(false);
});

test("every primary documentation reader bounds actual streamed responses", async () => {
  const readers = [
    (fetchImpl: typeof fetch) => fetchMarkdown({ url: "https://docs.example.test/" }, fetchImpl),
    (fetchImpl: typeof fetch) => fetchOpenAPI("https://docs.example.test/", fetchImpl),
    (fetchImpl: typeof fetch) => fetchGoogleDiscovery("https://docs.example.test/", fetchImpl),
    (fetchImpl: typeof fetch) => fetchIntrospection("https://docs.example.test/", fetchImpl),
    (fetchImpl: typeof fetch) =>
      ingestLlmsTxt("https://docs.example.test/", createBudgetState(), fetchImpl),
  ];
  for (const read of readers) {
    const stream = endlessResponse();
    await expect(read(responseFetch(() => stream.response))).rejects.toBeInstanceOf(
      PageTooLargeError,
    );
    expect(stream.canceled()).toBe(true);
    expect(stream.pulls()).toBeLessThanOrEqual(PER_PAGE_BYTES / 65_536 + 2);
  }
});

test("cascade probes and link extraction cancel every oversized stream without retaining content", async () => {
  const streams: ReturnType<typeof endlessResponse>[] = [];
  const fetchImpl = responseFetch(() => {
    const stream = endlessResponse();
    streams.push(stream);
    return stream.response;
  });
  expect(await discoverOpenApiLinks("https://docs.example.test/", fetchImpl)).toEqual([]);
  const result = await cascadeIngest({ base_url: "https://docs.example.test/", fetchImpl });
  expect(result.chunks).toHaveLength(0);
  expect(streams.length).toBeGreaterThan(5);
  expect(
    streams.every((stream) => stream.canceled() && stream.pulls() <= PER_PAGE_BYTES / 65_536 + 2),
  ).toBe(true);
});

test("external references and llms links retain the same bounded reader", async () => {
  for (const kind of ["openapi", "llms"] as const) {
    const stream = endlessResponse();
    const fetchImpl = responseFetch((url) =>
      url.includes("child")
        ? stream.response
        : new Response(
            kind === "openapi"
              ? JSON.stringify({
                  openapi: "3.0.0",
                  info: { title: "Synthetic", version: "test" },
                  paths: {},
                  components: {
                    schemas: { Child: { $ref: "https://docs.example.test/child.json" } },
                  },
                })
              : "# Docs\n\n[Child](https://docs.example.test/child.md)",
          ),
    );
    if (kind === "openapi")
      await ingestOpenAPIUrl("https://docs.example.test/root.json", createBudgetState(), fetchImpl);
    else await ingestLlmsTxt("https://docs.example.test/llms.txt", createBudgetState(), fetchImpl);
    expect(stream.canceled()).toBe(true);
    expect(stream.pulls()).toBeLessThanOrEqual(PER_PAGE_BYTES / 65_536 + 2);
  }
});
