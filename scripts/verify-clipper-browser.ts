import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { clipperArchiveManifest, clipperArchivePath } from "../apps/sk/src/clipper-assets.ts";
import { installClipper } from "../apps/sk/src/clipper-install.ts";

const root = join(import.meta.dir, "..");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "subkit-clipper-browser-")));
const extensionPath = join(temporary, "extension");
const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let version = "initial";
let conflict = true;
const documents: Array<{ path: string; content: string }> = [];
let loseCreateResponse = false;
const newCollections: Array<{
  id: string;
  name: string;
  slug: string;
  source_type: string;
  scope: string;
  documents: Array<{ path: string; content: string }>;
}> = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    const url = new URL(request.url);
    if (url.pathname === "/fixture") {
      return new Response(
        '<!doctype html><html><head><title>Fixture article</title><meta name="author" content="Fixture author"></head><body><article><h1>Fixture article</h1><p id="selection">Selected <strong>important text</strong> with a <a href="/reference">reference</a> and <img src="/picture.png" alt="Fixture illustration"></p><p>Additional article body for extraction.</p><script>window.fixtureLoaded = true</script></article></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    }
    if (!url.pathname.startsWith("/engine/")) return new Response(null, { status: 404 });
    assert.equal(request.headers.get("Authorization"), "Bearer browser-test-key");
    assert.ok(url.pathname.startsWith("/engine/v1/knowledge-sources"));
    if (request.method === "GET" && url.pathname.endsWith("/knowledge-sources")) {
      return Response.json(
        {
          items: [
            {
              id: "global-bundle",
              name: "Global collection",
              source_type: "bundle",
              scope: "global",
              slug: "global",
            },
            {
              id: "workflow-bundle",
              name: "Workflow collection",
              source_type: "bundle",
              scope: "workflow",
              workflow_id: "workflow",
              slug: "workflow",
            },
            { id: "inline", name: "Individual source", source_type: "inline", scope: "global" },
            ...newCollections,
          ],
          total: 3 + newCollections.length,
        },
        { headers },
      );
    }
    if (request.method === "GET" && url.pathname.endsWith("/content")) {
      const sourceId = url.pathname.split("/").at(-2);
      const collection = newCollections.find((item) => item.id === sourceId);
      return Response.json(
        {
          knowledge_source_id: sourceId,
          version,
          editable: true,
          documents: collection?.documents ?? documents,
        },
        { headers },
      );
    }
    const body = (await request.json()) as Record<string, unknown>;
    writes.push({ method: request.method, path: url.pathname, body });
    if (url.pathname.endsWith("/bundle")) {
      assert.equal(body.create_only, true);
      const existing = newCollections.find((item) => item.slug === body.slug);
      if (existing)
        return Response.json(
          { code: "slug_exists", details: { knowledge_source_id: existing.id } },
          { status: 409, headers },
        );
      const created = {
        id: `new-${newCollections.length}`,
        name: String(body.name),
        slug: String(body.slug),
        source_type: "bundle",
        scope: "global",
        documents: body.files as Array<{ path: string; content: string }>,
      };
      newCollections.push(created);
      if (loseCreateResponse) {
        loseCreateResponse = false;
        created.documents.push({ path: "/concurrent.md", content: "Another writer's content" });
        return Response.json({ message: "Response lost after commit" }, { status: 503, headers });
      }
      return Response.json({ knowledge_source: created }, { headers });
    }
    if (conflict) {
      conflict = false;
      return Response.json(
        { code: "version_conflict", message: "Collection changed" },
        { status: 409, headers },
      );
    }
    if (body.expected_version !== version)
      return Response.json(
        { code: "version_conflict", message: "Collection changed" },
        { status: 409, headers },
      );
    const existing = documents.find((document) => document.path === body.path);
    if (request.method === "POST" && existing)
      return Response.json(
        { code: "path_exists", message: "Document exists" },
        { status: 409, headers },
      );
    version = `saved-${writes.length}`;
    if (existing) existing.content = String(body.content);
    else documents.push({ path: String(body.path), content: String(body.content) });
    return Response.json(
      { knowledge_source_id: "workflow-bundle", version, path: body.path },
      { status: 201, headers },
    );
  },
});
const engineUrl = `http://127.0.0.1:${server.port}/engine`;
try {
  await installClipper({
    archivePath: clipperArchivePath,
    manifest: clipperArchiveManifest,
    targetDir: extensionPath,
    engineUrl,
  });
  const browser = await chromium.launchPersistentContext(join(temporary, "loaded-profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async (url) => {
      const extension = globalThis as unknown as {
        chrome: { storage: { local: { set(values: unknown): Promise<void> } } };
      };
      await extension.chrome.storage.local.set({
        settings: { engineUrl: url, apiKey: "browser-test-key", language: "de" },
        draft: {
          id: "browser-draft",
          engineUrl: url,
          metadata: {
            title: "Browser article",
            sourceUrl: "https://example.test/article",
            capturedAt: "2020-01-01T00:00:00Z",
          },
          body: "# Browser article\n\nSelected content.",
          state: "ready",
        },
      });
    }, engineUrl);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const manager = await browser.newPage();
    await manager.goto("chrome://extensions");
    await manager.evaluate(
      async ({ extensionId, origin }) => {
        const management = globalThis as unknown as {
          chrome: {
            developerPrivate: {
              addHostPermission(extensionId: string, host: string): Promise<void>;
            };
          };
        };
        await management.chrome.developerPrivate.addHostPermission(extensionId, `${origin}/*`);
      },
      { extensionId, origin: new URL(engineUrl).origin },
    );
    await manager.close();
    process.stdout.write("Checking extension settings form\n");
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#api-key")?.value === "browser-test-key",
    );
    process.stdout.write("Submitting extension settings form\n");
    await page.locator("button[type=submit]").click();
    await page.waitForFunction(() => Boolean(document.querySelector("#status")?.textContent));
    assert.equal(await page.locator("#status").getAttribute("data-error"), "false");
    const article = await browser.newPage();
    await article.goto(`${new URL(engineUrl).origin}/fixture`);
    await article.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#selection") as Node);
      window.getSelection()?.addRange(range);
    });
    const captured = (await worker.evaluate(async () => {
      const extension = globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: {
              active: boolean;
              currentWindow: boolean;
            }): Promise<Array<{ id: number }>>;
            sendMessage(id: number, message: unknown): Promise<unknown>;
          };
          scripting: {
            executeScript(details: {
              target: { tabId: number };
              files: string[];
            }): Promise<unknown>;
          };
        };
      };
      const [tab] = await extension.chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("Fixture tab missing");
      await extension.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["capture.js"],
      });
      return extension.chrome.tabs.sendMessage(tab.id, { type: "capture", mode: "selection" });
    })) as { metadata: { author: string }; body: string };
    assert.equal(captured.metadata.author, "Fixture author");
    assert.ok(captured.body.includes("**important text**"));
    assert.ok(captured.body.includes(`${new URL(engineUrl).origin}/reference`));
    assert.ok(
      captured.body.includes(`![Fixture illustration](${new URL(engineUrl).origin}/picture.png)`),
    );
    assert.ok(!captured.body.includes("Additional article body"));
    assert.ok(!captured.body.includes("fixtureLoaded"));
    await article.evaluate(() => window.getSelection()?.removeAllRanges());
    const fallback = await worker.evaluate(async () => {
      const extension = globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: {
              active: boolean;
              currentWindow: boolean;
            }): Promise<Array<{ id: number }>>;
            sendMessage(id: number, message: unknown): Promise<{ body: string }>;
          };
          scripting: {
            executeScript(details: {
              target: { tabId: number };
              func: () => Promise<boolean>;
            }): Promise<Array<{ result: boolean }>>;
          };
        };
      };
      const [tab] = await extension.chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("Fixture tab missing");
      const article = await extension.chrome.tabs.sendMessage(tab.id, {
        type: "capture",
        mode: "selection",
      });
      const storageProbe = await extension.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const api = globalThis as unknown as {
            chrome: { storage: { local: { get(key: string): Promise<unknown> } } };
          };
          try {
            await api.chrome.storage.local.get("settings");
            return false;
          } catch {
            return true;
          }
        },
      });
      return { article, protectedStorage: storageProbe[0]?.result };
    });
    assert.ok(fallback.article.body.includes("Additional article body"));
    assert.equal(fallback.protectedStorage, true);

    process.stdout.write("Checking saved draft\n");
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.locator("#source option[value='workflow-bundle']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#source option").count(), 3);
    await page.locator("#title").fill("Edited article");
    await page.locator("#content").fill("# Edited\n\nRetained draft content.");
    await page.locator("#source").selectOption("workflow-bundle");
    await page.reload();
    await page.locator("#source option[value='workflow-bundle']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#title").inputValue(), "Edited article");
    assert.equal(await page.locator("#source").inputValue(), "workflow-bundle");
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#status")?.getAttribute("data-error") === "true",
    );
    assert.equal(await page.locator("#duplicate").isVisible(), false);
    assert.equal(writes.length, 1);
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesichert"),
    );
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.path, "/engine/v1/knowledge-sources/workflow-bundle/documents");
    assert.match(String(writes[1]?.body.path), /^\/clips\/[a-f0-9]{12}\.md$/);
    assert.ok(String(writes[1]?.body.content).includes("Retained draft content."));
    async function seedDraft(body: string, sourceId?: string): Promise<void> {
      await worker.evaluate(
        async ({ engineUrl, body, sourceId }) => {
          const extension = globalThis as unknown as {
            chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
          };
          await extension.chrome.storage.local.set({
            draft: {
              id: "next-draft",
              engineUrl,
              metadata: {
                title: "Another clip",
                sourceUrl: "https://example.test/article",
                capturedAt: "2020-01-01T00:00:00Z",
              },
              body,
              state: "ready",
              ...(sourceId ? { sourceId } : { collectionName: "New collection" }),
            },
          });
        },
        { engineUrl, body, sourceId },
      );
      await page.reload();
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>("#content")?.value === expected,
        body,
      );
      await page.locator("#source option[value='workflow-bundle']").waitFor({ state: "attached" });
    }
    await seedDraft("Replacement content", "workflow-bundle");
    await page.locator("#save").click();
    await page.locator("#duplicate").waitFor({ state: "visible" });
    const beforeReplace = writes.length;
    await page.locator("#replace").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesichert"),
    );
    assert.equal(writes.length, beforeReplace + 1);
    assert.equal(writes.at(-1)?.method, "PUT");
    assert.ok(documents[0]?.content.includes("Replacement content"));
    await seedDraft("Copy content", "workflow-bundle");
    await page.locator("#save").click();
    await page.locator("#duplicate").waitFor({ state: "visible" });
    await page.locator("#copy").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesichert"),
    );
    assert.equal(documents.length, 2);
    assert.ok(documents[0]?.content.includes("Replacement content"));
    assert.ok(documents[1]?.content.includes("Copy content"));
    await seedDraft("Conflicting replacement", "workflow-bundle");
    await page.locator("#save").click();
    await page.locator("#duplicate").waitFor({ state: "visible" });
    version = "concurrent-change";
    const originalDocument = documents[0];
    assert.ok(originalDocument);
    originalDocument.content = "Changed by another writer";
    const beforeConflict = writes.length;
    await page.locator("#replace").click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#save")?.disabled);
    assert.equal(writes.length, beforeConflict + 1);
    assert.equal(originalDocument.content, "Changed by another writer");
    await page.locator("#save").click();
    await page.locator("#duplicate").waitFor({ state: "visible" });
    const changedUrl = "https://example.test/changed-url";
    await page.locator("#source-url").fill(changedUrl);
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesichert"),
    );
    assert.equal(documents.length, 3);
    assert.equal(
      documents[2]?.path,
      `/clips/${createHash("sha256").update(changedUrl).digest("hex").slice(0, 12)}.md`,
    );
    assert.equal(originalDocument.content, "Changed by another writer");
    await seedDraft("First collection clip");
    loseCreateResponse = true;
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#status")?.getAttribute("data-error") === "true",
    );
    const afterUncertainCreate = writes.length;
    assert.equal(newCollections.length, 1);
    assert.equal(newCollections[0]?.documents.length, 2);
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesichert"),
    );
    assert.equal(writes.length, afterUncertainCreate);
    assert.equal(newCollections.length, 1);
    assert.equal(newCollections[0]?.documents[1]?.content, "Another writer's content");
    await mkdir(join(root, ".artifacts"), { recursive: true });
    await page.screenshot({ path: join(root, ".artifacts/clipper-preview.png"), fullPage: true });
    const reloadManager = await browser.newPage();
    await reloadManager.goto("chrome://extensions");
    const reloadedWorker = browser.waitForEvent("serviceworker", {
      predicate: (item) => new URL(item.url()).host === extensionId,
    });
    await reloadManager.evaluate(async (id) => {
      const manager = globalThis as unknown as {
        chrome: {
          developerPrivate: {
            reload(id: string): Promise<void>;
            updateProfileConfiguration(config: { inDeveloperMode: boolean }): Promise<void>;
          };
        };
      };
      await manager.chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
      await manager.chrome.developerPrivate.reload(id);
    }, extensionId);
    await reloadManager.waitForFunction(async (id) => {
      const manager = globalThis as unknown as {
        chrome: { developerPrivate: { getExtensionInfo(id: string): Promise<{ state: string }> } };
      };
      try {
        return (await manager.chrome.developerPrivate.getExtensionInfo(id)).state === "ENABLED";
      } catch {
        return false;
      }
    }, extensionId);
    const wakePage = await browser.newPage();
    await wakePage.goto(`chrome-extension://${extensionId}/options.html`);
    await wakePage.evaluate(async () => {
      const extension = globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      };
      await extension.chrome.runtime.sendMessage({ type: "settings-updated" });
    });
    const nextWorker = await reloadedWorker;
    await wakePage.close();
    await article.bringToFront();
    const afterReload = await nextWorker.evaluate(async () => {
      const extension = globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: {
              active: boolean;
              currentWindow: boolean;
            }): Promise<Array<{ id: number }>>;
            sendMessage(id: number, message: unknown): Promise<{ body: string }>;
          };
          scripting: {
            executeScript(details: {
              target: { tabId: number };
              files: string[];
            }): Promise<unknown>;
          };
        };
      };
      const [tab] = await extension.chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("Fixture tab missing after update");
      await extension.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["capture.js"],
      });
      return extension.chrome.tabs.sendMessage(tab.id, { type: "capture", mode: "article" });
    });
    assert.ok(afterReload.body.includes("Additional article body"));
    await article.close();
    await reloadManager.close();
    assert.deepEqual(errors, []);
    process.stdout.write(
      "Clipper loaded in Chromium; selection/article capture, protected storage, settings, draft persistence, collection selection and conflict retry passed.\n",
    );
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
