import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.COCKPIT_BASE_URL || "http://127.0.0.1:4175").replace(/\/$/, "");
const outputDir = resolve(process.env.COCKPIT_SCREENSHOT_DIR || ".artifacts/cockpit-sweep/local");
const uuid = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const routes = [
  "decisions",
  "chat",
  "inbox",
  "workflows",
  "runs",
  "connectors",
  "knowledge",
  "skills",
  "files",
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

function sse(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: outcome\ndata: ${JSON.stringify(body)}\n\n`,
  });
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
        "workflow:write",
        "execution:read",
        "connector:read",
        "connector:write",
        "connector:test",
        "knowledge:read",
        "knowledge:write",
        "skill:read",
        "skill:write",
        "file:read",
        "file:write",
        "notification:read",
        "audit:read",
        "stats:read",
        "stats:read:all",
        "identity:read",
        "rbac:read",
        "api_key:read",
        "settings:read",
        "identity:write",
        "rbac:write",
        "api_key:write",
        "api_key:rotate",
        "api_key:revoke",
        "settings:write",
        "self_healing:read",
        "self_healing:write",
      ],
      csrf_token: "test-csrf",
      version: "visual-sweep",
      recent_conversations: [],
    });
  }
  if (path === "/v1/conversations" && request.method() === "GET")
    return json(route, { items: conversations, total: conversations.length });
  if (path === "/v1/conversations" && request.method() === "POST")
    return sse(route, { conversation, status: "active" });
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
    return sse(route, { conversation, status: "active" });
  if (path === `/v1/workflows/${uuid}`)
    return json(route, {
      id: uuid,
      name: "Monatsreport",
      slug: "monatsreport",
      lifecycle: "active",
      current_version: 8,
      steps: [
        { id: "fetch", name: "Daten laden", kind: "request" },
        { id: "transform", name: "Report berechnen", kind: "transform" },
      ],
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/connectors/${uuid}`)
    return json(route, {
      id: uuid,
      display_name: "Reporting API",
      slug: "reporting-api",
      driver: "http",
      environment: "prod",
      enabled: true,
      health_state: "ok",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/knowledge-sources/${uuid}`)
    return json(route, {
      id: uuid,
      name: "Betriebshandbuch",
      status: "active",
      source_type: "file_upload",
      version: "knowledge-v4",
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/knowledge-sources/${uuid}/content`)
    return json(route, {
      knowledge_source_id: uuid,
      version: "knowledge-v4",
      editable: true,
      documents: [
        {
          path: "betrieb.md",
          content:
            "# Betriebshandbuch\n\n| Prüfung | Intervall | Verantwortlich |\n|---|---:|---|\n| Connector-Zustand | täglich | Betrieb |",
        },
      ],
    });
  if (path === `/v1/skills/${uuid}`)
    return json(route, {
      id: uuid,
      title: "Sichere Reports",
      body: "# Sichere Reports\n\nVor externen Schreibzugriffen immer eine Freigabe einholen.",
      scope: "global",
      status: "active",
      maturity: "stable",
      version: 3,
      updated_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/files/${uuid}`)
    return json(route, {
      id: uuid,
      filename: "report-notes.md",
      status: "ready",
      content_type: "text/markdown",
      size_bytes: 1840,
      created_at: "2026-08-10T09:00:00.000Z",
    });
  if (path === `/v1/files/${uuid}/content`)
    return route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: "# Report notes\n\nValidated input.",
    });
  if (
    [
      "/v1/workflows",
      "/v1/connectors",
      "/v1/knowledge-sources",
      "/v1/skills",
      "/v1/files",
    ].includes(path)
  ) {
    const item =
      path === "/v1/workflows"
        ? {
            id: uuid,
            name: "Monatsreport",
            lifecycle: "active",
            current_version: 8,
            connectors: ["reporting"],
            updated_at: conversation.updated_at,
          }
        : path === "/v1/connectors"
          ? {
              id: uuid,
              display_name: "Reporting API",
              driver: "http",
              environment: "prod",
              health_state: "ok",
              enabled: true,
              updated_at: conversation.updated_at,
            }
          : path === "/v1/knowledge-sources"
            ? {
                id: uuid,
                name: "Betriebshandbuch",
                status: "active",
                source_type: "file_upload",
                chunk_count: 12,
                bytes_total: 18400,
                updated_at: conversation.updated_at,
              }
            : path === "/v1/skills"
              ? {
                  id: uuid,
                  title: "Sichere Reports",
                  status: "active",
                  scope: "global",
                  maturity: "stable",
                  version: 3,
                  updated_at: conversation.updated_at,
                }
              : {
                  id: uuid,
                  filename: "report-notes.md",
                  status: "ready",
                  content_type: "text/markdown",
                  size_bytes: 1840,
                  created_at: conversation.updated_at,
                };
    const items = Array.from({ length: 42 }, (_, index) => ({
      ...item,
      id: index === 0 ? uuid : `catalog-record-${index}`,
    }));
    return json(route, { items, total: items.length });
  }
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
            source: "tenant",
            scope: "tenant",
            sensitive: false,
            requiresRestart: false,
            kind: "boolean",
          },
        },
      ],
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    });
  if (path === "/v1/identity/users")
    return json(route, {
      items: [
        {
          id: uuid,
          email: "mike@mikebild.com",
          role: "admin",
          effective_role: "admin",
          role_consistent: true,
          status: "active",
        },
      ],
    });
  if (path === "/v1/identity/api-keys")
    return json(route, {
      items: [
        {
          id: uuid,
          name: "Cockpit verification",
          prefix: "wf_live_demo",
          scopes: ["workflow:read", "workflow:run"],
          created_at: "2026-08-10T07:00:00.000Z",
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
        },
      ],
    });
  if (path === "/v1/rbac/roles")
    return json(route, {
      items: [
        { id: uuid, name: "admin", description: "Workspace administration", is_builtin: true },
        {
          id: "00000000-0000-4000-8000-000000000002",
          name: "metrics_scraper",
          description: "Prometheus scraper: scoped to metrics:read only",
          is_builtin: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          name: "portal_token_user",
          description: "Backing role for portal-token principals",
          is_builtin: true,
        },
      ],
    });
  if (path === "/v1/rbac/groups")
    return json(route, { items: [{ id: uuid, name: "Operations", description: "Operators" }] });
  if (path === "/v1/rbac/grants")
    return json(route, {
      items: [
        {
          id: uuid,
          subject_type: "group",
          resource_type: "workflow",
          permission: "workflow:run",
          expires_at: null,
        },
      ],
    });
  if (path === "/v1/rbac/permissions")
    return json(route, {
      items: [
        {
          name: "workflow:run",
          description: "Run workflows",
          resource_type: "workflow",
        },
      ],
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
  if (route === "chat") return '[data-testid="chat-workspace"]';
  if (["people", "access", "api-access", "operations", "settings"].includes(route))
    return `[data-testid="admin-${route}"]`;
  if (["workflows", "connectors", "knowledge", "skills", "files"].includes(route))
    return `[data-testid="catalog-${route}"]`;
  return `[data-testid="resource-${route}"]`;
}

function documentThemeMatches(classes, theme) {
  const dark = classes?.split(/\s+/).includes("dark") ?? false;
  return theme === "dark" ? dark : !dark;
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
  const unsafeOverflows = await page
    .locator('[data-slot="table-container"]')
    .evaluateAll((elements) =>
      elements
        .map((element, index) => ({
          index,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: window.getComputedStyle(element).overflowX,
        }))
        .filter(
          (entry) =>
            entry.scrollWidth > entry.clientWidth + 1 &&
            entry.overflowX !== "auto" &&
            entry.overflowX !== "scroll",
        ),
    );
  if (unsafeOverflows.length) throw new Error(`${label} has uncontained table overflow`);
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
          `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 32) || "unlabelled"}] ${element.outerHTML.slice(0, 180)}`,
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
const variants = locales.flatMap((locale) =>
  ["light", "dark"].map((theme) => ({
    ...locale,
    theme,
    artifact: `${locale.name}-${theme}`,
  })),
);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide", width: 1990, height: 1090 },
  { name: "mobile", width: 390, height: 844 },
];

for (const locale of variants) {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      locale: locale.browser,
    });
    await context.addInitScript(
      ({ language, theme }) => {
        localStorage.setItem("sk-cockpit-locale", language);
        localStorage.setItem("sk-cockpit-theme", theme);
      },
      { language: locale.name, theme: locale.theme },
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      const message = `${locale.artifact}/${viewport.name}: ${error.message}`;
      errors.push(message);
      console.error(message);
    });
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error(`${locale.artifact}/${viewport.name}: ${message.text()}`);
    });
    await page.route("**/v1/**", mockApi);
    for (const route of routes) {
      const response = await page.goto(`${baseUrl}/cockpit/${route}`, { waitUntil: "networkidle" });
      if (!response?.ok())
        throw new Error(
          `${locale.artifact}/${viewport.name}/${route} returned HTTP ${response?.status()}`,
        );
      try {
        await page.locator(markerFor(route)).waitFor({ state: "visible" });
      } catch (error) {
        const body = await page
          .locator("body")
          .innerText()
          .catch(() => "body unavailable");
        throw new Error(
          `${locale.artifact}/${viewport.name}/${route} did not mount: ${body.slice(0, 1000)}`,
          { cause: error },
        );
      }
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
        throw new Error(`${locale.artifact}/${viewport.name}/${route} displays a resource error`);
      const text = await page.locator("body").innerText();
      if (text.includes(uuid))
        throw new Error(`${locale.artifact}/${viewport.name}/${route} exposes a UUID`);
      if ((await page.locator("html").getAttribute("lang")) !== locale.name)
        throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong locale`);
      if (!documentThemeMatches(await page.locator("html").getAttribute("class"), locale.theme))
        throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong theme`);
      await assertViewport(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertTables(page, `${locale.artifact}/${viewport.name}/${route}`);
      await assertInteractiveSelectors(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "chat") await assertChat(page, `${locale.artifact}/${viewport.name}/${route}`);
      if (route === "access") {
        const localizedRoles =
          locale.name === "de"
            ? ["Metrik-Abruf", "Portalnutzer", "Kann Prometheus-Metriken", "Portal-Zugriffstoken"]
            : [
                "Metrics scraper",
                "Portal token user",
                "Can read Prometheus metrics",
                "portal access tokens",
              ];
        for (const expected of localizedRoles) {
          if (!text.includes(expected)) {
            throw new Error(
              `${locale.artifact}/${viewport.name}/${route} misses localized built-in role text: ${expected}`,
            );
          }
        }
      }
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-${viewport.name}-${route}.png`),
        fullPage: false,
      });
    }
    if (viewport.name === "desktop") {
      for (const resource of ["workflows", "connectors", "knowledge", "skills", "files"]) {
        await page.goto(`${baseUrl}/cockpit/${resource}/${uuid}`, { waitUntil: "networkidle" });
        await page.locator(`[data-testid="detail-${resource}"]`).waitFor({ state: "visible" });
        await assertViewport(page, `${locale.artifact}/desktop/${resource}-detail`);
        await assertTables(page, `${locale.artifact}/desktop/${resource}-detail`);
        await assertInteractiveSelectors(page, `${locale.artifact}/desktop/${resource}-detail`);
        await page.screenshot({
          path: resolve(outputDir, `${locale.artifact}-desktop-${resource}-detail.png`),
          fullPage: false,
        });
      }
      await page.goto(`${baseUrl}/cockpit/chat`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="conversation-new"]').click();
      await page
        .locator('[data-testid="conversation-create-dialog"]')
        .waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-desktop-chat-create.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="conversation-create-cancel"]').click();
      const tool = page.locator('[data-testid="chat-message-3-tool-0"]');
      await tool.scrollIntoViewIfNeeded();
      await page.locator('[data-testid="chat-message-3-tool-0-toggle"]').click();
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-desktop-chat-tool.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="chat-context-toggle"]').click();
      await page.locator('[data-testid="chat-context"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-desktop-chat-context.png`),
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
        path: resolve(outputDir, `${locale.artifact}-desktop-chat-interaction.png`),
        fullPage: false,
      });
      await page.goto(`${baseUrl}/cockpit/usage`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="resource-refresh"]').hover();
      await page.locator('[data-slot="tooltip-content"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-desktop-tooltip.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="account-menu-trigger"]').click();
      await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-desktop-account.png`),
        fullPage: false,
      });
      await page.locator('[data-testid="account-language-menu"]').hover();
      await page.locator('[data-testid="account-language-content"]').waitFor({ state: "visible" });
      await page.screenshot({
        path: resolve(outputDir, `${locale.artifact}-desktop-account-language.png`),
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
        path: resolve(outputDir, `${locale.artifact}-desktop-account-theme.png`),
        fullPage: false,
      });
    }
    await context.close();
  }
}

for (const locale of variants) {
  for (const viewport of ["desktop", "mobile"]) {
    const contact = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const cards = await Promise.all(
      routes.map(async (route) => {
        const bytes = await readFile(
          resolve(outputDir, `${locale.artifact}-${viewport}-${route}.png`),
        );
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
      path: resolve(outputDir, `${locale.artifact}-${viewport}-contact-sheet.png`),
      fullPage: true,
    });
    await contact.close();
  }
}
await browser.close();
if (errors.length) throw new Error(errors.join("; "));
console.log(
  `Cockpit visual sweep passed: ${routes.length * viewports.length * variants.length + variants.length * 12} screenshots in ${outputDir}`,
);
