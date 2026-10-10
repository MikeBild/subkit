import { expect, mock, test } from "bun:test";
import { waitFor } from "../../engine/src/test-helpers/determinism/wait.ts";
import { createDraft, listDrafts } from "./clipper.ts";
import type { CapturedClip, Draft } from "./types.ts";

type Sender = { id?: string; url?: string; tab?: { id?: number; url?: string } };
type Listener = (message: unknown, sender: Sender) => unknown;

type FixtureState = {
  activeTabId: number;
  capture: CapturedClip;
  captureError?: Error;
  executed: number[];
  extensionOrigin: string;
  onCapture?: (values: Record<string, unknown>) => void;
  opened: string[];
  tabUrls: Map<number, string>;
  values: Record<string, unknown>;
};

let current: FixtureState | undefined;
let listener: Listener | undefined;
let contextMenuListener:
  | ((info: { menuItemId: string }, tab?: { id?: number }) => void)
  | undefined;
let workerLoaded: Promise<unknown> | undefined;

const chromeBridge = {
  storage: {
    local: {
      get: async (keys?: string | string[]) => {
        const state = current;
        if (!state) throw new Error("No worker fixture is active.");
        if (!keys) return { ...state.values };
        const selected = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          selected.flatMap((key) => (key in state.values ? [[key, state.values[key]]] : [])),
        );
      },
      set: async (next: Record<string, unknown>) => {
        if (!current) throw new Error("No worker fixture is active.");
        Object.assign(current.values, next);
      },
      remove: async (keys: string | string[]) => {
        if (!current) throw new Error("No worker fixture is active.");
        for (const key of Array.isArray(keys) ? keys : [keys]) delete current.values[key];
      },
      setAccessLevel: async () => {},
    },
  },
  runtime: {
    id: "clipper",
    getURL: (path: string) => `${current?.extensionOrigin || "chrome-extension://clipper"}/${path}`,
    onMessage: { addListener: (next: Listener) => (listener = next) },
    openOptionsPage: async () => {},
  },
  tabs: {
    query: async () => {
      const state = current;
      if (!state) throw new Error("No worker fixture is active.");
      return [{ id: state.activeTabId, url: state.tabUrls.get(state.activeTabId) }];
    },
    get: async (id: number) => ({ id, url: current?.tabUrls.get(id) }),
    create: async ({ url }: { url: string }) => {
      current?.opened.push(url);
    },
    sendMessage: async () => {
      if (!current) throw new Error("No worker fixture is active.");
      if (current.captureError) throw current.captureError;
      current.onCapture?.(current.values);
      return current.capture;
    },
  },
  scripting: {
    executeScript: async ({ target }: { target: { tabId: number } }) => {
      current?.executed.push(target.tabId);
    },
  },
  contextMenus: {
    removeAll: async () => {},
    create: () => {},
    onClicked: {
      addListener: (next: (info: { menuItemId: string }, tab?: { id?: number }) => void) => {
        contextMenuListener = next;
      },
    },
  },
  commands: { onCommand: { addListener: () => {} } },
  permissions: { request: async () => true, remove: async () => true },
};

mock.module("./chrome-api.ts", () => ({ chromeApi: chromeBridge }));

function captured(sourceUrl: string, title = "Captured"): CapturedClip {
  return {
    metadata: { title, sourceUrl, capturedAt: "2026-10-10T00:00:00.000Z" },
    body: "Captured body",
  };
}

async function workerFixture(options: {
  activeTabId?: number;
  capture: CapturedClip;
  captureError?: Error;
  settings?: { engineUrl?: string };
  tabUrls?: Record<number, string>;
  onCapture?: (values: Record<string, unknown>) => void;
}) {
  const fixture: FixtureState = {
    activeTabId: options.activeTabId || 99,
    capture: options.capture,
    ...(options.captureError ? { captureError: options.captureError } : {}),
    executed: [],
    extensionOrigin: "chrome-extension://clipper",
    ...(options.onCapture ? { onCapture: options.onCapture } : {}),
    opened: [],
    tabUrls: new Map(Object.entries(options.tabUrls || {}).map(([id, url]) => [Number(id), url])),
    values: { settings: options.settings || { engineUrl: "https://engine.test" } },
  };
  current = fixture;
  workerLoaded ||= import("./service-worker.ts");
  await workerLoaded;
  const send = async (message: unknown, sender: Sender) => {
    if (!listener) throw new Error("Worker listener was not installed.");
    return await listener(message, sender);
  };
  return { ...fixture, send, storage: chromeBridge.storage.local };
}

test("captures from the current sender tab instead of an unrelated active tab", async () => {
  const fixture = await workerFixture({
    capture: captured("https://example.test/current"),
    tabUrls: { 7: "https://example.test/current", 99: "https://example.test/other" },
  });
  await fixture.send(
    { type: "start-capture", mode: "article" },
    {
      id: "clipper",
      url: `${fixture.extensionOrigin}/popup.html`,
      tab: { id: 7, url: "https://example.test/current" },
    },
  );
  expect(fixture.executed).toEqual([7]);
});

test("standalone popup captures its validated source tab route", async () => {
  const fixture = await workerFixture({
    capture: captured("https://example.test/routed"),
    tabUrls: { 7: "https://example.test/routed", 99: "https://example.test/other" },
  });
  await fixture.send(
    { type: "start-capture", mode: "article" },
    {
      id: "clipper",
      url: `${fixture.extensionOrigin}/popup.html?tab=7`,
      tab: { id: 70, url: `${fixture.extensionOrigin}/popup.html?tab=7` },
    },
  );
  expect(fixture.executed).toEqual([7]);
});

test("background failures open a standalone popup bound to the source tab", async () => {
  const fixture = await workerFixture({
    capture: captured("https://example.test/failure"),
    captureError: new Error("Capture failed"),
    tabUrls: { 7: "https://example.test/failure" },
  });
  if (!contextMenuListener) throw new Error("Context menu listener was not installed.");
  contextMenuListener({ menuItemId: "clip-page" }, { id: 7 });
  await waitFor(() => fixture.opened.length > 0);
  expect(fixture.opened).toEqual([`${fixture.extensionOrigin}/popup.html?tab=7`]);
});

test("does not save a capture after the page changed", async () => {
  const fixture = await workerFixture({
    capture: captured("https://example.test/before"),
    tabUrls: { 7: "https://example.test/after" },
  });
  await expect(
    fixture.send(
      { type: "start-capture", mode: "article" },
      {
        id: "clipper",
        url: `${fixture.extensionOrigin}/popup.html`,
        tab: { id: 7, url: "https://example.test/after" },
      },
    ),
  ).rejects.toThrow("page changed");
  expect(await listDrafts(fixture.storage)).toEqual([]);
});

test("does not save a capture under a different engine after settings change", async () => {
  const fixture = await workerFixture({
    capture: captured("https://example.test/page"),
    tabUrls: { 7: "https://example.test/page" },
    onCapture: (values) => {
      values.settings = { engineUrl: "https://other-engine.test" };
    },
  });
  await expect(
    fixture.send(
      { type: "start-capture", mode: "article" },
      {
        id: "clipper",
        url: `${fixture.extensionOrigin}/popup.html`,
        tab: { id: 7, url: "https://example.test/page" },
      },
    ),
  ).rejects.toThrow("engine address changed");
  expect(await listDrafts(fixture.storage)).toEqual([]);
});

test("reuses the matching page draft without returning an unrelated one", async () => {
  const old = createDraft(
    { title: "Edited title", sourceUrl: "https://example.test/page", capturedAt: "then" },
    "Edited body",
    "https://engine.test",
    7,
  );
  const fixture = await workerFixture({
    capture: captured("https://example.test/page"),
    tabUrls: { 7: "https://example.test/page" },
    settings: { engineUrl: "https://engine.test" },
  });
  fixture.values[`draft:${old.id}`] = old;
  const result = await fixture.send(
    { type: "start-capture", mode: "article" },
    {
      id: "clipper",
      url: `${fixture.extensionOrigin}/popup.html`,
      tab: { id: 7, url: "https://example.test/page" },
    },
  );
  expect(result).toMatchObject({ id: old.id, body: "Edited body" });
  expect((await listDrafts(fixture.storage)).map((draft) => draft.id)).toEqual([old.id]);
});

test("automatic capture recovers failed empty drafts while preserving user fields", async () => {
  const capture = captured("https://example.test/page");
  const old = createDraft(capture.metadata, "", "https://engine.test", 7, {
    diagnostics: [{ code: "selection_unavailable" }],
  });
  old.metadata = { ...old.metadata, title: "My title" };
  old.note = "My note";
  old.category = "research";
  const fixture = await workerFixture({ capture, tabUrls: { 7: capture.metadata.sourceUrl } });
  fixture.values[`draft:${old.id}`] = old;
  const result = await fixture.send(
    { type: "start-capture", mode: "auto" },
    { id: "clipper", url: `${fixture.extensionOrigin}/popup.html?tab=7` },
  );
  expect(result).toMatchObject({
    id: old.id,
    body: capture.body,
    metadata: { title: "My title" },
    note: "My note",
    category: "research",
    originalCapture: capture,
    diagnostics: [],
  });
});

test("automatic capture preserves a draft whose captured text was deliberately cleared", async () => {
  const capture = captured("https://example.test/page");
  const old = createDraft(capture.metadata, capture.body, "https://engine.test", 7);
  old.body = "";
  old.diagnostics = [{ code: "selection_unavailable" }];
  const fixture = await workerFixture({ capture, tabUrls: { 7: capture.metadata.sourceUrl } });
  fixture.values[`draft:${old.id}`] = old;
  const result = await fixture.send(
    { type: "start-capture", mode: "auto" },
    { id: "clipper", url: `${fixture.extensionOrigin}/popup.html?tab=7` },
  );
  expect(result).toMatchObject({ id: old.id, body: "", originalCapture: capture });
});

test("reused page drafts follow the tab that initiated the capture", async () => {
  const old = createDraft(
    { title: "Edited title", sourceUrl: "https://example.test/page", capturedAt: "then" },
    "Edited body",
    "https://engine.test",
    7,
  );
  const fixture = await workerFixture({
    capture: captured("https://example.test/page"),
    tabUrls: { 7: "https://example.test/page", 9: "https://example.test/page" },
    settings: { engineUrl: "https://engine.test" },
  });
  fixture.values[`draft:${old.id}`] = old;
  const result = await fixture.send(
    { type: "start-capture", mode: "article" },
    {
      id: "clipper",
      url: `${fixture.extensionOrigin}/popup.html`,
      tab: { id: 9, url: "https://example.test/page" },
    },
  );
  expect(result).toMatchObject({ id: old.id, captureTabId: 9 });
  expect(await listDrafts(fixture.storage)).toMatchObject([{ id: old.id, captureTabId: 9 }]);
});

test("draft reads wait for a queued popup edit", async () => {
  const original = createDraft(
    { title: "Before", sourceUrl: "https://example.test/page", capturedAt: "then" },
    "Before body",
    "https://engine.test",
    7,
  );
  const fixture = await workerFixture({
    capture: captured("https://example.test/page"),
    tabUrls: { 7: "https://example.test/page" },
    settings: { engineUrl: "https://engine.test" },
  });
  fixture.values[`draft:${original.id}`] = original;
  const edited = { ...original, metadata: { ...original.metadata, title: "After" } };
  const sender = { id: "clipper", url: `${fixture.extensionOrigin}/popup.html` };
  const saving = fixture.send({ type: "save-draft", draft: edited }, sender);
  const drafts = (await fixture.send({ type: "list-drafts" }, sender)) as Draft[];
  await saving;
  expect(drafts).toMatchObject([{ id: original.id, metadata: { title: "After" } }]);
});

test("keeps the newest immediate popup write when delivery arrives out of order", async () => {
  const original = createDraft(
    { title: "Original", sourceUrl: "https://example.test/page", capturedAt: "then" },
    "Original body",
    "https://engine.test",
    7,
  );
  const fixture = await workerFixture({
    capture: captured("https://example.test/page"),
    tabUrls: { 7: "https://example.test/page" },
  });
  fixture.values[`draft:${original.id}`] = original;
  const sender = { id: "clipper", url: `${fixture.extensionOrigin}/popup.html` };
  await fixture.send(
    {
      type: "save-draft",
      draft: {
        ...original,
        metadata: { ...original.metadata, title: "Newest" },
        writeRevision: 2,
      },
    },
    sender,
  );
  await fixture.send(
    {
      type: "save-draft",
      draft: {
        ...original,
        metadata: { ...original.metadata, title: "Stale" },
        writeRevision: 1,
      },
    },
    sender,
  );
  const restored = (await fixture.send(
    { type: "load-draft", draftId: original.id },
    sender,
  )) as Draft;
  expect(restored).toMatchObject({ metadata: { title: "Newest" }, writeRevision: 2 });
});

test("persists an immediate popup write for a fresh popup reload", async () => {
  const original = createDraft(
    { title: "Before close", sourceUrl: "https://example.test/page", capturedAt: "then" },
    "Before close body",
    "https://engine.test",
    7,
  );
  const fixture = await workerFixture({
    capture: captured("https://example.test/page"),
    tabUrls: { 7: "https://example.test/page" },
  });
  fixture.values[`draft:${original.id}`] = original;
  const sender = { id: "clipper", url: `${fixture.extensionOrigin}/popup.html` };
  await fixture.send(
    {
      type: "save-draft",
      draft: {
        ...original,
        metadata: { ...original.metadata, title: "Persisted before close" },
        writeRevision: 1,
      },
    },
    sender,
  );
  const restored = (await fixture.send(
    { type: "load-draft", draftId: original.id },
    sender,
  )) as Draft;
  expect(restored).toMatchObject({
    metadata: { title: "Persisted before close" },
    writeRevision: 1,
  });
});

test("recapturing the same source retains its revision against a late old write", async () => {
  const old = {
    ...createDraft(
      { title: "Old capture", sourceUrl: "https://example.test/page", capturedAt: "then" },
      "Old body",
      "https://engine.test",
      7,
    ),
    writeRevision: 3,
  };
  const fixture = await workerFixture({
    capture: captured("https://example.test/page", "Recaptured"),
    tabUrls: { 7: "https://example.test/page" },
    settings: { engineUrl: "https://engine.test" },
  });
  fixture.values[`draft:${old.id}`] = old;
  const sender = {
    id: "clipper",
    url: `${fixture.extensionOrigin}/popup.html?draft=${old.id}`,
    tab: { id: 70, url: `${fixture.extensionOrigin}/popup.html?draft=${old.id}` },
  };
  await fixture.send({ type: "discard-and-capture", mode: "article", draftId: old.id }, sender);
  await fixture.send({ type: "save-draft", draft: old }, sender);
  const restored = (await fixture.send({ type: "load-draft", draftId: old.id }, sender)) as Draft;
  expect(restored).toMatchObject({
    metadata: { title: "Recaptured" },
    body: "Captured body",
    writeRevision: 3,
  });
});

test("recapturing a navigated source preserves the old page draft", async () => {
  const old = createDraft(
    { title: "Old", sourceUrl: "https://example.test/old", capturedAt: "then" },
    "Old body",
    "https://engine.test",
    7,
  );
  const fixture = await workerFixture({
    capture: captured("https://example.test/new"),
    tabUrls: { 7: "https://example.test/new" },
    settings: { engineUrl: "https://engine.test" },
  });
  fixture.values[`draft:${old.id}`] = old;
  const result = await fixture.send(
    { type: "discard-and-capture", mode: "article", draftId: old.id },
    {
      id: "clipper",
      url: `${fixture.extensionOrigin}/popup.html?draft=${old.id}`,
      tab: { id: 70, url: `${fixture.extensionOrigin}/popup.html?draft=${old.id}` },
    },
  );
  expect(result).toMatchObject({ captureUrl: "https://example.test/new" });
  expect((await listDrafts(fixture.storage)).map((draft) => draft.captureUrl).sort()).toEqual([
    "https://example.test/new",
    "https://example.test/old",
  ]);
});
