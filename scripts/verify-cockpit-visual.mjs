import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.COCKPIT_BASE_URL || "http://127.0.0.1:4175").replace(/\/$/, "");
const outputDir = resolve(process.env.COCKPIT_SCREENSHOT_DIR || ".artifacts/cockpit-sweep/local");
const uuid = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const routes = [
  "chat",
  "inbox",
  "workflows",
  "runs",
  "connectors",
  "knowledge",
  "skills",
  "files",
  "approvals",
  "audit",
  "usage",
  "people",
  "access",
  "api-access",
  "operations",
  "settings",
];

const conversation = {
  id: uuid,
  tenant_id: uuid,
  target_workflow_id: null,
  target_connector_id: null,
  status: "active",
  owner_id: uuid,
  model: "test-model",
  title: "Monatsreport reparieren",
  created_at: "2026-08-01T09:00:00.000Z",
  updated_at: "2026-08-10T09:00:00.000Z",
  last_message_role: "assistant",
  last_message_excerpt: `{"tool":"run_workflow","output":{"execution_id":"${uuid}"}}`,
};

const conversations = Array.from({ length: 32 }, (_, index) => ({
  ...conversation,
  id: index === 0 ? uuid : `conversation-${index}`,
  title: index % 3 === 0 ? "Unbenannte Unterhaltung" : `Arbeitsauftrag ${index + 1}`,
  last_message_excerpt:
    index % 4 === 0
      ? `{"tool":"run_workflow","output":{"execution_id":"${uuid}"}}`
      : "Eine lange, aber verständliche Zusammenfassung des letzten Arbeitsschritts.",
  updated_at: new Date(Date.parse(conversation.updated_at) - index * 60_000).toISOString(),
}));

const baseMessages = [
  {
    id: "message-1",
    role: "user",
    created_at: "2026-08-10T08:00:00.000Z",
    parts: [{ type: "text", text: "Bitte repariere den Monatsreport." }],
  },
  {
    id: "message-2",
    role: "assistant",
    created_at: "2026-08-10T08:01:00.000Z",
    parts: [
      {
        type: "text",
        text: `${"Ich habe den Workflow geprüft und die fehlerhafte Transformation eingegrenzt. ".repeat(12)} Die Ausführung ${uuid} wird erst nach Ihrer Freigabe erneut gestartet.`,
      },
    ],
  },
  {
    id: "message-3",
    role: "user",
    created_at: "2026-08-10T08:02:00.000Z",
    parts: [{ type: "text", text: "Zeige mir zuerst die geplanten Änderungen." }],
  },
  {
    id: "message-4",
    role: "assistant",
    created_at: "2026-08-10T08:03:00.000Z",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "validate_workflow",
        toolCallId: "tool-call-1",
        state: "output-available",
        input: { name: "Monatsreport" },
        output: { status: "valid" },
      },
    ],
  },
];

const messages = [
  ...baseMessages,
  ...Array.from({ length: 36 }, (_, index) => ({
    id: `history-message-${index}`,
    role: index % 3 === 0 ? "user" : "assistant",
    created_at: new Date(Date.parse("2026-08-10T08:04:00.000Z") + index * 60_000).toISOString(),
    parts: [
      {
        type: "text",
        text:
          index % 3 === 0
            ? `Prüfschritt ${index + 1}: Bitte den beobachteten Wert verifizieren.`
            : `${"Der Prüfschritt wurde nachvollziehbar ausgewertet. ".repeat(8)}Lange Werte wie ${"products[0].revenue.last30Days.observedAt".repeat(4)} müssen umbrechen.`,
      },
    ],
  })),
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === "/v1/cockpit/bootstrap") {
    return json(route, {
      principal: {
        id: uuid,
        kind: "user",
        email: "mike@mikebild.com",
        role_name: "admin",
        provider: "browser_session",
      },
      tenant: { id: uuid, slug: "default", display_name: "Default Tenant" },
      session: { expires_at: "2026-08-11T09:00:00.000Z", absolute_expires_at: null },
      permissions: [
        "conversation:read",
        "conversation:write",
        "conversation:approve",
        "workflow:read",
        "execution:read",
        "connector:read",
        "knowledge:read",
        "skill:read",
        "file:read",
        "notification:read",
        "audit:read",
        "stats:read",
        "stats:read:all",
        "identity:read",
        "rbac:read",
        "api_key:read",
        "settings:read",
      ],
      csrf_token: "test-csrf",
      version: "visual-sweep",
      recent_conversations: [],
    });
  }
  if (path === "/v1/conversations" && request.method() === "GET")
    return json(route, { items: conversations });
  if (path === "/v1/conversations" && request.method() === "POST")
    return json(route, { conversation, events: [], status: "active" }, 201);
  if (path === `/v1/conversations/${uuid}`) {
    return json(route, {
      conversation,
      messages,
      tool_calls: [],
      resume_summary: {
        active_target: { kind: "none", name: "none", slug: null, id: null, environment: null },
        stage: "onboarding",
        last_successful_probe: null,
        last_successful_preview: null,
        unsaved: false,
        pending_approval: null,
        next_action: "Continue the conversation.",
        one_sentence: "You have an in-progress conversation. Continue the conversation.",
      },
    });
  }
  if (path === `/v1/conversations/${uuid}/messages`)
    return json(route, { conversation, events: [], status: "active" });
  if (path === "/v1/stats/executions") {
    if (!url.searchParams.get("bucket") || !url.searchParams.get("from"))
      return json(route, { code: "validation", message: "request validation failed" }, 400);
    return json(route, {
      bucket: "day",
      tz: "UTC",
      from: "2026-07-11T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
      groups: [
        {
          key: {},
          buckets: [
            {
              ts: "2026-08-09T00:00:00.000Z",
              executions: 18,
              duration_ms: { total: 18000, avg: 1000, p50: 800, p95: 2100, p99: 2400, max: 2600 },
            },
            {
              ts: "2026-08-10T00:00:00.000Z",
              executions: 22,
              duration_ms: { total: 26400, avg: 1200, p50: 900, p95: 2500, p99: 2900, max: 3200 },
            },
          ],
          totals: {
            executions: 40,
            duration_ms: { total: 44400, avg: 1110, p50: 850, p95: 2300, p99: 2700, max: 3200 },
          },
        },
      ],
      totals: {
        executions: { count: 40, by_status: { completed: 36, failed: 4 } },
        duration_ms: { total: 44400, avg: 1110, p50: 850, p95: 2300, p99: 2700, max: 3200 },
      },
    });
  }
  if (path === "/v1/operator/health-digest")
    return json(route, {
      generated_at: "2026-08-10T09:00:00.000Z",
      window_hours: 24,
      headline: "Alle überwachten Systeme arbeiten normal.",
      failure_groups: [],
      patch_candidates: { pending: 0, items: [] },
      risk: [],
      rendered: "All clear",
      all_clear: true,
    });
  if (path === "/v1/settings")
    return json(route, {
      items: [
        {
          path: "execution.default_timeout_ms",
          value: 30000,
          meta: {
            source: "default",
            scope: "tenant",
            sensitive: false,
            requiresRestart: false,
            kind: "number",
          },
        },
        {
          path: "observability.usage.enabled",
          value: true,
          meta: {
            source: "config",
            scope: "global",
            sensitive: false,
            requiresRestart: false,
            kind: "boolean",
          },
        },
      ],
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/skill-candidates" || path === "/v1/patch-candidates")
    return json(route, {
      items: [
        {
          id: uuid,
          title: "Sichere Fehlerbehandlung",
          status: "proposed",
          created_at: "2026-08-10T07:00:00.000Z",
        },
      ],
    });

  const label = path.split("/").filter(Boolean).at(-1)?.replaceAll("-", " ") || "record";
  return json(route, {
    items: Array.from({ length: 14 }, (_, index) => ({
      id: uuid,
      tenant_id: uuid,
      name: `${label.charAt(0).toUpperCase()}${label.slice(1)} Beispiel ${index + 1} mit einem sehr langen verständlichen Namen`,
      status: "active",
      type: `workspace-${"long-value-".repeat(5)}${index + 1}`,
      created_at: "2026-08-10T07:00:00.000Z",
    })),
  });
}

function markerFor(route) {
  return route === "chat" ? '[data-testid="chat-workspace"]' : `[data-testid="resource-${route}"]`;
}

async function assertViewport(page, label) {
  const geometry = await page.evaluate(() => {
    const content = document.querySelector('[data-testid="page-content"]');
    if (!(content instanceof HTMLElement)) throw new Error("page content missing");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
      contentWidth: content.scrollWidth,
      contentClientWidth: content.clientWidth,
      contentBottom: content.getBoundingClientRect().bottom,
    };
  });
  if (
    geometry.bodyWidth > geometry.viewportWidth + 1 ||
    geometry.contentWidth > geometry.contentClientWidth + 1
  )
    throw new Error(`${label} has horizontal overflow`);
  if (
    geometry.bodyHeight > geometry.viewportHeight + 1 ||
    geometry.contentBottom > geometry.viewportHeight + 1
  )
    throw new Error(`${label} grows beyond the viewport`);
}

async function assertChat(page, label) {
  const layout = await page.evaluate(() => {
    const rect = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`${testId} missing`);
      return element.getBoundingClientRect().toJSON();
    };
    return {
      transcript: rect("chat-transcript"),
      composer: rect("chat-composer-area"),
      main: rect("chat-main"),
      sidebar: rect("conversation-sidebar"),
    };
  });
  if (layout.transcript.height < 120) throw new Error(`${label} transcript collapsed`);
  if (layout.transcript.bottom > layout.composer.top + 1)
    throw new Error(`${label} transcript overlaps composer`);
  if (layout.composer.bottom > layout.main.bottom + 1)
    throw new Error(`${label} composer is outside Chat`);
  const sidebarText = await page.locator('[data-testid="conversation-item-0"]').innerText();
  if (sidebarText.includes('{"tool"')) throw new Error(`${label} exposes a raw tool payload`);
  const assistantWidths = await page
    .locator('[data-testid^="chat-message-"][data-testid$="-content"]')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  if (assistantWidths.some((width) => width > layout.main.width - 24))
    throw new Error(`${label} message content reaches outside its readable column`);
}

async function assertTables(page, label) {
  const overflows = await page.locator('[data-slot="table-container"]').evaluateAll((elements) =>
    elements
      .map((element, index) => ({
        index,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      .filter((entry) => entry.scrollWidth > entry.clientWidth + 1),
  );
  if (overflows.length) throw new Error(`${label} has horizontally scrolling tables`);
}

async function assertInteractiveSelectors(page, label) {
  const missing = await page
    .locator('button, input, textarea, a[href], [role="menuitem"], [role="menuitemradio"]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
        if (!visible || element.hasAttribute("data-testid")) return [];
        return [
          `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 32) || "unlabelled"}]`,
        ];
      }),
    );
  if (missing.length) throw new Error(`${label} has interactives without data-testid: ${missing}`);
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const locales = [
  { name: "de", browser: "de-DE" },
  { name: "en", browser: "en-US" },
];
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide", width: 1990, height: 1090 },
  { name: "mobile", width: 390, height: 844 },
];

for (const locale of locales) {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      locale: locale.browser,
    });
    await context.addInitScript((preference) => {
      localStorage.setItem("sk-cockpit-locale", preference);
    }, locale.name);
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      errors.push(`${locale.name}/${viewport.name}: ${error.message}`),
    );
    await page.route("**/v1/**", mockApi);
    for (const route of routes) {
      const response = await page.goto(`${baseUrl}/cockpit/${route}`, { waitUntil: "networkidle" });
      if (!response?.ok())
        throw new Error(
          `${locale.name}/${viewport.name}/${route} returned HTTP ${response?.status()}`,
        );
      await page.locator(markerFor(route)).waitFor({ state: "visible" });
      await page
        .locator('[data-testid="resource-error"]')
        .waitFor({ state: "hidden" })
        .catch(() => {});
      if (
        await page
          .locator('[data-testid="resource-error"]')
          .isVisible()
          .catch(() => false)
      )
        throw new Error(`${locale.name}/${viewport.name}/${route} displays a resource error`);
      const text = await page.locator("body").innerText();
      if (text.includes(uuid))
        throw new Error(`${locale.name}/${viewport.name}/${route} exposes a UUID`);
      if ((await page.locator("html").getAttribute("lang")) !== locale.name)
        throw new Error(`${locale.name}/${viewport.name}/${route} uses the wrong locale`);
      await assertViewport(page, `${locale.name}/${viewport.name}/${route}`);
      await assertTables(page, `${locale.name}/${viewport.name}/${route}`);
      await assertInteractiveSelectors(page, `${locale.name}/${viewport.name}/${route}`);
      if (route === "chat") await assertChat(page, `${locale.name}/${viewport.name}/${route}`);
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-${viewport.name}-${route}.png`),
        fullPage: false,
      });
    }
    if (viewport.name === "desktop") {
      await page.goto(`${baseUrl}/cockpit/chat`, { waitUntil: "networkidle" });
      const tool = page.locator('[data-testid="chat-message-3-tool-0"]');
      await tool.scrollIntoViewIfNeeded();
      await page.locator('[data-testid="chat-message-3-tool-0-toggle"]').click();
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-chat-tool.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="chat-context-toggle"]').click();
      await page.locator('[data-testid="chat-context"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-chat-context.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="chat-context-close"]').click();
      await page
        .locator('[data-testid="chat-composer-input"]')
        .fill("Prüfe den Workflow, ohne ihn auszuführen.");
      await page.locator('[data-testid="chat-composer-submit"]').click();
      await page
        .locator('[data-testid="chat-error"]')
        .waitFor({ state: "hidden" })
        .catch(() => {});
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-chat-interaction.png`),
        fullPage: false,
      });
      await page.goto(`${baseUrl}/cockpit/usage`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="resource-refresh"]').hover();
      await page.locator('[data-slot="tooltip-content"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-tooltip.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="account-menu-trigger"]').click();
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-account.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="account-language-menu"]').hover();
      await page.locator('[data-testid="account-language-content"]').waitFor({ state: "visible" });
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-account-language.png`),
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="account-language-content"]').waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "hidden" });
      await page.locator('[data-testid="account-menu-trigger"]').click();
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="account-theme-menu"]').hover();
      await page.locator('[data-testid="account-theme-content"]').waitFor({ state: "visible" });
      await page.screenshot({
        path: resolve(outputDir, `${locale.name}-desktop-account-theme.png`),
        fullPage: false,
      });
    }
    await context.close();
  }
}

for (const locale of locales) {
  for (const viewport of ["desktop", "mobile"]) {
    const contact = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const cards = await Promise.all(
      routes.map(async (route) => {
        const bytes = await readFile(resolve(outputDir, `${locale.name}-${viewport}-${route}.png`));
        const source = `data:image/png;base64,${bytes.toString("base64")}`;
        return `<figure><img src="${source}" alt=""><figcaption>${route}</figcaption></figure>`;
      }),
    );
    await contact.setContent(
      `<style>
      * { box-sizing: border-box }
      body { margin: 0; padding: 16px; background: #e2e8f0; font: 14px system-ui }
      main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px }
      figure { margin: 0; overflow: hidden; border-radius: 8px; background: white; box-shadow: 0 1px 3px #64748b }
      img { display: block; width: 100%; aspect-ratio: ${viewport === "desktop" ? "1.44" : "0.462"}; object-fit: cover; object-position: top }
      figcaption { padding: 8px; font-weight: 600 }
    </style><main>${cards.join("")}</main>`,
      { waitUntil: "load" },
    );
    await contact.screenshot({
      path: resolve(outputDir, `${locale.name}-${viewport}-contact-sheet.png`),
      fullPage: true,
    });
    await contact.close();
  }
}
await browser.close();
if (errors.length) throw new Error(errors.join("; "));
console.log(
  `Cockpit visual sweep passed: ${routes.length * viewports.length * locales.length + locales.length * 7} screenshots in ${outputDir}`,
);
