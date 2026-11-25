import { afterAll, expect, mock, test } from "bun:test";
import { waitFor } from "../../engine/src/test-helpers/determinism/wait.ts";

const originalNavigator = globalThis.navigator;
const originalDocument = (globalThis as { document?: unknown }).document;
const originalFetch = globalThis.fetch;

const languageField = { value: "" };
const root = { lang: "" };
const fields: Record<string, unknown> = { "#language": languageField };

Object.defineProperty(globalThis, "navigator", {
  value: { language: "en-US" },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "document", {
  value: {
    documentElement: root,
    querySelector: (selector: string) => fields[selector] ?? null,
    querySelectorAll: () => [],
  },
  configurable: true,
  writable: true,
});
globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

mock.module("./chrome-api.ts", () => ({
  chromeApi: {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: { getURL: (path: string) => `chrome-extension://clipper/${path}` },
  },
  sendRuntimeMessage: async () => undefined,
}));

afterAll(() => {
  Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
  Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
  globalThis.fetch = originalFetch;
});

test("options preselect the browser language when no language is stored", async () => {
  await import("./options.ts");
  await waitFor(() => root.lang, { label: "options language applied" });
  expect(root.lang).toBe("en");
  expect(languageField.value).toBe("en");
});
