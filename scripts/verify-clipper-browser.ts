import assert from "node:assert/strict";
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
let loseResponse = true;
let supportsIntake = true;
const defaultCategory = "research";
const categories = ["inbox", "research"];
const collected = new Map<string, Record<string, unknown>>();
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
    if (url.pathname === "/engine/cockpit/chat/new") return new Response("Chat review");
    assert.equal(request.headers.get("Authorization"), "Bearer browser-test-key");
    assert.ok(
      !url.pathname.includes("knowledge-sources"),
      "Clipper must never write directly to knowledge",
    );
    if (!supportsIntake) return Response.json({ message: "Not found" }, { status: 404, headers });
    if (request.method === "GET" && url.pathname.endsWith("/categories"))
      return Response.json(
        { categories: categories.map((category) => ({ category })) },
        { headers },
      );
    if (request.method === "GET" && url.pathname.endsWith("/intake/default-category"))
      return Response.json({ category: defaultCategory }, { headers });
    const body = (await request.json()) as Record<string, unknown>;
    writes.push({ method: request.method, path: url.pathname, body });
    assert.ok(url.pathname.endsWith("/intake/items"));
    const key = String(body.client_request_id);
    let item = collected.get(key);
    if (!item) {
      item = {
        ...body,
        id: `00000000-0000-4000-8000-${String(collected.size + 1).padStart(12, "0")}`,
        category: body.category || defaultCategory,
        state: "collected",
      };
      collected.set(key, item);
    } else assert.equal(item.body, body.body);
    if (loseResponse) {
      loseResponse = false;
      return Response.json({ message: "Connection lost after saving" }, { status: 503, headers });
    }
    return Response.json(item, { headers });
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
    assert.equal(fallback.article.body, "");
    assert.equal(fallback.protectedStorage, true);

    process.stdout.write("Checking intake draft and idempotent retries\n");
    await page.goto(`chrome-extension://${extensionId}/popup.html?draft=browser-draft`);
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    await worker.evaluate(async (url) => {
      const extension = globalThis as unknown as {
        chrome: { storage: { local: { set(values: unknown): Promise<void> } } };
      };
      await extension.chrome.storage.local.set({
        "draft:other-browser-draft": {
          id: "other-browser-draft",
          engineUrl: url,
          captureUrl: "https://example.test/other",
          createdAt: "2020-01-01T00:00:00Z",
          updatedAt: "2020-01-01T00:00:00Z",
          metadata: {
            title: "Other browser article",
            sourceUrl: "https://example.test/other",
            capturedAt: "2020-01-01T00:00:00Z",
          },
          body: "Other selected content.",
          state: "ready",
        },
      });
    }, engineUrl);
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#draft-picker-label").isVisible(), true);
    assert.equal(await page.locator("#draft-picker option").count(), 2);
    assert.equal(await page.locator("#category").inputValue(), "research");
    assert.equal(
      await page.locator("#source-url").getAttribute("href"),
      "https://example.test/article",
    );
    await page.setViewportSize({ width: 400, height: 600 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(
        (expected) => {
          const save = document.querySelector("#save");
          return save && getComputedStyle(save).backgroundColor === expected;
        },
        scheme === "light" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)",
      );
      const theme = await page.evaluate(() => ({
        background: getComputedStyle(document.body).backgroundColor,
        primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.equal(theme.background, scheme === "light" ? "rgb(255, 255, 255)" : "rgb(2, 8, 23)");
      assert.equal(theme.primary, scheme === "light" ? "#0f172a" : "#f8fafc");
      assert.equal(theme.overflowing, false);
      await page.locator("#save").focus();
      assert.equal(
        await page.locator("#save").evaluate((button) => button === document.activeElement),
        true,
      );
      await page.screenshot({
        path: join(root, `.artifacts/clipper-collect-${scheme}.png`),
        animations: "disabled",
        fullPage: true,
      });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator("#note").fill("A useful note that explains why this source matters later.");
    await page.locator("#status").evaluate((element) => {
      element.textContent = "Sammeln ist gerade nicht verfügbar. Dein Entwurf bleibt gespeichert.";
      element.dataset.error = "true";
    });
    const fields = page.locator(".fields");
    const actions = page.locator(".actions");
    const sourceBox = await page.locator("#category").boundingBox();
    const actionsBox = await actions.boundingBox();
    assert.ok(sourceBox && actionsBox && sourceBox.y + sourceBox.height <= actionsBox.y);
    await fields.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const pickerBox = await page.locator("#draft-picker").boundingBox();
    const afterScrollActionsBox = await actions.boundingBox();
    assert.ok(
      pickerBox &&
        afterScrollActionsBox &&
        pickerBox.y >= 0 &&
        pickerBox.y + pickerBox.height <= afterScrollActionsBox.y,
    );
    assert.equal(
      await page.locator("#note").inputValue(),
      "A useful note that explains why this source matters later.",
    );
    await page.screenshot({
      path: join(root, ".artifacts/clipper-compact-multiline-error.png"),
      animations: "disabled",
    });
    await page.locator("#status").evaluate((element) => {
      element.textContent = "";
      element.dataset.error = "false";
    });
    await fields.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(root, ".artifacts/clipper-collect.png"), fullPage: true });
    await page.locator("#title").fill("Edited article");
    await page.locator("#note").fill("Useful for our next project");
    await page.locator("#capture-details summary").click();
    await page.locator("#content").fill("# Edited\n\nRetained draft content.");
    await page.locator("#category").selectOption("inbox");
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#title").inputValue(), "Edited article");
    assert.equal(await page.locator("#note").inputValue(), "Useful for our next project");
    assert.equal(await page.locator("#category").inputValue(), "inbox");
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#status")?.getAttribute("data-error") === "true",
    );
    assert.equal(collected.size, 1);
    assert.equal(await page.locator("#title").isDisabled(), true);
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesammelt"),
    );
    assert.equal(collected.size, 1);
    const submissions = writes.filter((item) => item.path.endsWith("/intake/items"));
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0]?.body, submissions[1]?.body);
    assert.ok(submissions[0]);
    assert.equal(submissions[0].body.note, "Useful for our next project");
    assert.equal(
      (submissions[0].body.original_snapshot as { origin: string }).origin,
      "restored_draft",
    );
    assert.equal(defaultCategory, "research");
    assert.equal(await page.locator("#review").isVisible(), true);
    const reviewOpened = browser.waitForEvent("page");
    await page.locator("#review").click();
    const reviewPage = await reviewOpened;
    await reviewPage.waitForURL("**/cockpit/chat/new?intake_item_ids=*");
    assert.equal(
      new URL(reviewPage.url()).searchParams.get("intake_item_ids"),
      [...collected.values()][0]?.id,
    );
    assert.ok(new URL(reviewPage.url()).searchParams.get("prompt")?.includes("Quelle"));
    assert.equal(
      new URL(reviewPage.url()).searchParams.get("references"),
      `intake_item:${[...collected.values()][0]?.id}`,
    );
    await reviewPage.close();
    async function seedDraft(
      body: string,
      sourceId?: string,
      sections?: { description: string; transcript: string; transcriptLanguage?: string },
    ): Promise<void> {
      await worker.evaluate(
        async ({ engineUrl, body, sourceId, sections }) => {
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
              ...(sections ? { sections } : {}),
              state: "ready",
              ...(sourceId ? { category: sourceId } : { category: "new-category" }),
            },
          });
        },
        { engineUrl, body, sourceId, sections },
      );
      await page.goto(`chrome-extension://${extensionId}/popup.html?draft=next-draft`);
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>("#content")?.value === expected,
        body,
      );
      await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    }
    await seedDraft("First category clip");
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Gesammelt"),
    );
    assert.equal(collected.size, 2);
    await seedDraft("", "research");
    assert.equal(await page.locator("#save").isDisabled(), true);
    supportsIntake = false;
    await page.reload();
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        ?.textContent?.includes("Sammeln ist gerade nicht verfügbar"),
    );
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.equal(
      await page.locator("#category option:checked").textContent(),
      "Kategorien gerade nicht verfügbar",
    );
    assert.equal(await page.locator("#content").inputValue(), "");
    await page.locator("#note").fill("Keep this note while the engine is unavailable.");
    assert.equal(
      await page
        .locator("#status")
        .evaluate((element) => element.textContent?.includes("Request failed")),
      false,
    );
    assert.ok(
      (await page.locator("#content-preview").textContent())?.includes(
        "Markiere den gewünschten Text",
      ),
    );
    assert.equal(await page.locator("#check-connection").isVisible(), true);
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.screenshot({
      path: join(root, ".artifacts/clipper-startup-404-empty.png"),
      animations: "disabled",
    });
    await page.locator(".fields").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const previewBox = await page.locator("#content-preview").boundingBox();
    const unavailableActionsBox = await page.locator(".actions").boundingBox();
    assert.ok(
      previewBox &&
        unavailableActionsBox &&
        previewBox.y >= 0 &&
        previewBox.y + previewBox.height <= unavailableActionsBox.y,
    );
    assert.ok(
      unavailableActionsBox && unavailableActionsBox.y + unavailableActionsBox.height <= 600,
    );
    await page.screenshot({
      path: join(root, ".artifacts/clipper-startup-404-empty-instruction.png"),
      animations: "disabled",
    });
    const optionsOpened = browser.waitForEvent("page");
    await page.locator("#check-connection").click();
    const optionsPage = await optionsOpened;
    await optionsPage.waitForURL("**/options.html");
    await optionsPage.close();
    assert.equal(collected.size, 2);
    supportsIntake = true;
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#check-connection").isVisible(), false);
    assert.equal(await page.locator("#save").isDisabled(), true);
    assert.equal(await page.locator("#category").inputValue(), "research");
    assert.equal(
      await page.locator("#note").inputValue(),
      "Keep this note while the engine is unavailable.",
    );
    if (await page.locator("#capture-details").evaluate((element) => !element.hasAttribute("open")))
      await page.locator("#capture-details summary").click();
    await page.locator("#content").fill("Recovered content after the engine update.");
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>("#save")?.disabled === false,
    );
    await page.locator("#discard").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#content")?.value === "",
    );
    await mkdir(join(root, ".artifacts"), { recursive: true });
    process.stdout.write("Checking video preview and persistent section choices\n");
    const sections = {
      description: "Useful video description.",
      transcript: "**0:00** · Useful spoken content.",
      transcriptLanguage: "en",
    };
    await seedDraft(
      `## Description\n\n${sections.description}\n\n## Transcript\n\n${sections.transcript}`,
      "research",
      sections,
    );
    await page.locator("#capture-details summary").click();
    await page.locator("#include-transcript").uncheck();
    assert.ok(!(await page.locator("#content").inputValue()).includes("Useful spoken content"));
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#include-transcript").isChecked(), false);
    await page.locator("#capture-details summary").click();
    await page.locator("#include-transcript").check();
    assert.ok((await page.locator("#content").inputValue()).includes("Useful spoken content"));
    await page.locator("#content").fill("Manual edit <script>alert('unsafe')</script>");
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    await page.locator("#capture-details summary").click();
    await page.locator("#include-transcript").click();
    assert.equal(
      await page.locator("#content").inputValue(),
      "Manual edit <script>alert('unsafe')</script>",
    );
    assert.equal(await page.locator("#content-preview script").count(), 0);
    await page.setViewportSize({ width: 400, height: 600 });
    const saveBox = await page.locator("#save").boundingBox();
    assert.ok(saveBox && saveBox.y >= 450 && saveBox.y + saveBox.height <= 600);
    await page.screenshot({ path: join(root, ".artifacts/clipper-popup-compact.png") });
    await page.locator("#discard").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#content")?.value === "",
    );
    process.stdout.write("Checking page-scoped drafts and navigation recapture\n");
    const tabId = await worker.evaluate(async (url) => {
      const extension = globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: Record<string, never>): Promise<Array<{ id: number; url?: string }>>;
          };
        };
      };
      const tabs = await extension.chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === url);
      if (!tab) throw new Error("Source fixture tab missing");
      return tab.id;
    }, article.url());
    await page.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    assert.equal(await page.locator("#video-sections").isVisible(), false);
    await page.locator("#title").fill("Preserved page A edit");
    const pageADraftId = new URL(page.url()).searchParams.get("draft");
    assert.ok(pageADraftId);
    await article.evaluate(() => {
      history.pushState({}, "", "/fixture?second=1");
      document.querySelector("h1")!.textContent = "Second fixture article";
      document.title = "Second fixture article";
    });
    await page.waitForFunction(() =>
      document.querySelector<HTMLAnchorElement>("#source-url")?.href.includes("second=1"),
    );
    const pageBDraftId = new URL(page.url()).searchParams.get("draft");
    assert.ok(pageBDraftId && pageBDraftId !== pageADraftId);
    await page.reload();
    await page.locator("#category option[value='research']").waitFor({ state: "attached" });
    assert.ok(
      ((await page.locator("#source-url").getAttribute("href")) || "").includes("second=1"),
    );
    const anotherArticle = await browser.newPage();
    await anotherArticle.goto(`${new URL(engineUrl).origin}/fixture?third=1`);
    await page.bringToFront();
    await anotherArticle.bringToFront();
    await page.waitForFunction(() =>
      document.querySelector<HTMLAnchorElement>("#source-url")?.href.includes("third=1"),
    );
    await article.bringToFront();
    await page.waitForFunction(() =>
      document.querySelector<HTMLAnchorElement>("#source-url")?.href.includes("second=1"),
    );
    await page.bringToFront();
    await page.locator("#draft-picker").selectOption(pageADraftId);
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#title")?.value === "Preserved page A edit",
    );
    assert.ok(
      !((await page.locator("#source-url").getAttribute("href")) || "").includes("second=1"),
    );
    await page.locator("#discard").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#content")?.value === "",
    );
    assert.equal(await page.locator(`#draft-picker option[value='${pageBDraftId}']`).count(), 1);
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
      "Clipper loaded in Chromium; selection/article capture, protected storage, settings, draft persistence, intake selection, original provenance, safe old-server behavior and idempotent retry passed.\n",
    );
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
