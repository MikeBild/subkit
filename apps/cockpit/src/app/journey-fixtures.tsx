import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { type TranslationKey, translate } from "@/lib/i18n";

const CHILD_FLAG = "SUBKIT_JOURNEYS_CHILD";
const INSTALLATION = "7c1e2a90-3b4d-4f5e-8a6b-0c9d8e7f6a5b";
export const BASE = `/cockpit/i/${INSTALLATION}`;
const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
export const WORKFLOW = "33333333-3333-4333-8333-333333333333";
export const RUN = "44444444-4444-4444-8444-444444444444";
export const INTAKE = "55555555-5555-4555-8555-555555555555";
const NOT_FOUND = translate("de", "failure.notFound.title");
export const de = (key: TranslationKey) => translate("de", key);

export function isolated(path: string, name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env[CHILD_FLAG] !== "1") {
      const child = Bun.spawnSync([process.execPath, "test", path, "-t", name], {
        env: { ...process.env, [CHILD_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }
    await body();
  }, 60_000);
}

export const NOW = "2026-11-23T10:00:00.000Z";

const bootstrap = {
  principal: {
    id: USER,
    kind: "user",
    email: "mira@example.com",
    display_name: "Mira",
    role_name: "owner",
    is_owner: true,
    provider: "browser_session",
  },
  tenant: {
    id: TENANT,
    slug: "acme",
    display_name: "Acme",
    timezone: "Europe/Berlin",
    language: "de",
    origin: "self_hosted",
    engine_operator: false,
  },
  session: { expires_at: "2026-12-23T10:00:00.000Z", absolute_expires_at: null },
  start_steps: {
    hidden: true,
    connector: true,
    workflow: true,
    run: true,
    people: true,
    client: true,
  },
  ai_access: { configured: true, provider: "anthropic", model: null, own_key: false },
  identity_memberships: false,
  permissions: [
    "workflow:read",
    "workflow:write",
    "workflow:run",
    "execution:read",
    "intake:read",
    "intake:write",
    "conversation:write",
    "connector:read",
    "audit:read",
  ],
  csrf_token: "csrf",
  version: "12.1.5",
  oauth_callback_url: null,
  recent_conversations: [],
};

function attentionItem(overrides: Record<string, unknown>) {
  return {
    class: "decide",
    severity: "notice",
    trigger: null,
    cause_class: null,
    counts: {},
    since: NOW,
    deadline: null,
    detail: null,
    ...overrides,
  };
}

const attention = {
  schema_version: "attention.v1",
  generated_at: NOW,
  sources: Object.fromEntries(
    [
      "conversations",
      "schedules",
      "freshness",
      "failures",
      "patches",
      "connectors",
      "connections",
      "secret_approvals",
      "skills",
      "intake",
      "budget",
      "ai_access",
      "risk",
      "tasks",
    ].map((source) => [source, "answered"]),
  ),
  status: null,
  items: [
    attentionItem({
      id: "intake",
      kind: "intake",
      subject: null,
      reason: "intake_collected",
      counts: { intake: 2, intake_by_category: { email: 2 } },
      actions: [
        {
          verb: "review",
          href: "/cockpit/intake?category=all",
          primary: true,
          permission: "intake:read",
        },
      ],
    }),
    attentionItem({
      id: `workflow:${WORKFLOW}`,
      class: "stopped",
      severity: "urgent",
      kind: "workflow",
      subject: { kind: "workflow", id: WORKFLOW, name: "TestFlight invite via Gmail v2" },
      reason: "version_needs_repair",
      repair: {
        remedy_kind: "reconnect",
        steps: 1,
        step_id: "send",
        code: "connector_missing",
        candidate_id: null,
        execution_id: null,
      },
      actions: [
        {
          verb: "open",
          href: `/cockpit/workflows/${WORKFLOW}#workflow-automation`,
          primary: true,
          permission: "workflow:write",
        },
      ],
    }),
  ],
};

const setup = {
  ask_before_writing: true,
  default_environment: "prod",
  approver: { kind: "self" },
  notifications: { kind: "immediate" },
  timezone: "Europe/Berlin",
  critical_breakthrough: true,
  first_job: null,
  services: [],
  unset: [],
  recommended: {
    ask_before_writing: true,
    default_environment: "prod",
    approver: { kind: "self" },
    notifications: { kind: "immediate" },
    critical_breakthrough: true,
  },
};

type Handler = (url: URL, init?: RequestInit) => unknown;

export const workflow = {
  id: WORKFLOW,
  operating_status: "repair_required",
  connector_references: [],
  creator: { kind: "user", id: USER },
  checksum: null,
  tenant_id: TENANT,
  slug: "testflight-invite",
  category: "operations",
  category_source: "author",
  name: "TestFlight invite via Gmail v2",
  description: null,
  description_source: "author",
  lifecycle: "active",
  current_version_id: null,
  draft_version_id: null,
  current_version: 2,
  created_at: NOW,
  updated_at: NOW,
  last_executed_at: null,
  health_state: "unknown",
  health_reason: null,
  health_changed_at: null,
  invalid: false,
  steps: [],
  input_schema: null,
  output_schema: null,
  output_transform: null,
  output_transform_function: null,
  response_filters: null,
  validation_expression: null,
  validation_function: null,
  timeout_ms: null,
  max_llm_tokens_per_run: null,
  trigger: { kind: "request" },
  schedule: null,
  webhooks_active: 0,
  effective_trigger: { kind: "request", source: "default", state: "active" },
  connectors: [],
  authority_environments: { dev: null, prod: null },
};

export const intakeEntry = {
  id: INTAKE,
  tenant_id: TENANT,
  category: "operations",
  client_request_id: "c",
  title: "Delivery notes without an order number",
  body: "Text",
  note: "",
  state: "collected",
  version: 1,
  collected_by: { kind: "user", id: USER },
  admitted_target_kind: null,
  admitted_target_id: null,
  created_at: NOW,
  updated_at: NOW,
  original_snapshot: { origin: "note", title: "t", captured_at: NOW, body: "b" },
  attachment: null,
};

export const run = {
  id: RUN,
  execution_id: RUN,
  error: null,
  workflow_id: WORKFLOW,
  workflow_name: workflow.name,
  workflow_version_id: null,
  execution_authority_id: null,
  execution_environment: "prod",
  permission_basis: null,
  permission_phase: null,
  permission_checked_at: null,
  source_kind: "saved",
  source_ref: null,
  status: "succeeded",
  request_source: "cockpit",
  caller: {
    kind: "user",
    principal_id: USER,
    provider: null,
    product_id: null,
    verified_by: "browser_session",
    channel: "cockpit",
    origin_execution_id: null,
  },
  parent_execution_id: null,
  started_at: NOW,
  finished_at: NOW,
  created_at: NOW,
};

export const runDetail = {
  ...run,
  trace_id: null,
  outcome: {
    kind: "succeeded",
    failed_step: null,
    cause_class: "ok",
    error_code: null,
    refusal_reason: null,
    connector: null,
    steps: { total: 1, succeeded: 1, failed: 0, held: 0, skipped: 0 },
    output_contract: "none",
    rerun_safety: { mode: "repeat_safe", reason: "read_only" },
  },
  result_markdown: "Invite sent",
  result_markdown_truncated: false,
};

const BASE_ROUTES: Record<string, Handler> = {
  "/v1/executions": () => ({ items: [run], next_cursor: null }),
  [`/v1/executions/${RUN}`]: () => runDetail,
  [`/v1/executions/${RUN}/steps`]: () => ({ items: [], next_cursor: null }),
  "/v1/workflows": () => ({ items: [workflow], total: 1, categories: [] }),
  [`/v1/workflows/${WORKFLOW}`]: () => workflow,
  "/v1/schedules": () => ({ schedules: [], total: 0 }),
  [`/v1/workflows/${WORKFLOW}/diagnosis`]: () => ({
    workflow_id: WORKFLOW,
    workflow_version_id: null,
    environment: "dev",
    is_current: true,
    diagnoses: [
      {
        code: "connector_missing",
        subject: { step_id: "send" },
        evidence: {},
        remedy_kind: "reconnect",
      },
    ],
  }),
  "/v1/categories": () => ({ categories: [] }),
  "/v1/intake/default-category": () => ({ category: "operations" }),
  "/v1/intake/items": () => ({ items: [intakeEntry] }),
  [`/v1/intake/items/${INTAKE}`]: () => intakeEntry,
  "/v1/intake/proposals": () => ({ items: [] }),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function api(routes: Record<string, Handler>, seen: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
    const path = url.pathname.replace(`${BASE}/api`, "");
    seen.push(`${init?.method ?? "GET"} ${path}${url.search}`);
    for (const [pattern, handler] of Object.entries({ ...BASE_ROUTES, ...routes }))
      if (new RegExp(`^${pattern}$`).test(path)) {
        const answer = handler(url, init);
        return answer instanceof Response ? answer : json(answer);
      }
    if (path === "/v1/cockpit/bootstrap") return json(bootstrap);
    if (path === "/v1/attention") return json(attention);
    if (path === "/v1/identity/me/setup") return json(setup);
    return json({ items: [], next_cursor: null, total: 0 });
  };
}

export async function mount(
  path: string,
  routes: Record<string, Handler> = {},
  options: { reducedMotion?: boolean } = {},
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost${BASE}${path}`,
    pretendToBeVisual: true,
  });
  dom.window.matchMedia = (query: string) =>
    ({
      matches: Boolean(options.reducedMotion) && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  const seen: string[] = [];
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    matchMedia: dom.window.matchMedia,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    EventSource: class {
      close() {}
      addEventListener() {}
      removeEventListener() {}
    },
    scrollTo: () => {},
    fetch: api(routes, seen),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of Object.getOwnPropertyNames(dom.window))
    if (/^(?:HTML|SVG)\w*Element$|^(?:Text|DocumentFragment|Range|DOMParser|\w+Event)$/.test(name))
      globals[name] ??= (dom.window as unknown as Record<string, unknown>)[name];
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  dom.window.fetch = globals.fetch as typeof fetch;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.localStorage.setItem("sk-cockpit-locale", "de");
  const workerListeners: ((event: { data: unknown; source: unknown }) => void)[] = [];
  Object.defineProperty(dom.window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: null,
      ready: new Promise(() => {}),
      addEventListener: (
        type: string,
        listener: (event: { data: unknown; source: unknown }) => void,
      ) => {
        if (type === "message") workerListeners.push(listener);
      },
      removeEventListener() {},
      startMessages() {},
      getRegistration: async () => undefined,
      getRegistrations: async () => [],
    },
  });
  await act(async () => {
    await import("../main");
  });
  const { router } = await import("./router");
  const { routerTarget } = await import("./links");
  const { STANDALONE_ROUTES } = await import("./route-table");
  const settle = async (rounds = 20) => {
    for (let round = 0; round < rounds; round += 1)
      await act(async () => {
        // allow-wall-clock: the mounted app settles routing and query timers between journey steps.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      });
  };
  await settle();
  const body = () => dom.window.document.body;
  const find = (testId: string) => body().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = async (testId: string) => {
    const element = find(testId);
    if (!element) throw new Error(`${testId} is missing on ${dom.window.location.pathname}`);
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await settle();
  };
  const notify = async (href: string) => {
    await act(async () => {
      for (const listener of workerListeners)
        listener({
          data: { type: "open", href },
          source: { scriptURL: `http://localhost${BASE}/sw.js` },
        });
    });
    await settle();
  };
  const at = (route: string) => {
    expect(dom.window.location.pathname).toBe(`${BASE}${route}`);
    expect(find("not-found-home")).toBeNull();
    expect(find("fatal-error-home")).toBeNull();
    expect(body().textContent).not.toContain(NOT_FOUND);
    const dead = [...body().querySelectorAll("a[href]")]
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/") && !href.startsWith("//"))
      .filter((href) => !href.startsWith(`${BASE}/api/`))
      .filter((href) => {
        if (!(href === BASE || (href.startsWith(BASE) && "/?#".includes(href.charAt(BASE.length)))))
          return true;
        const to = routerTarget(href).to;
        if ((STANDALONE_ROUTES as readonly string[]).includes(to)) return false;
        const found = router.getMatchedRoutes(to)[2];
        return !found || found.id === "__root__";
      });
    expect(dead).toEqual([]);
  };
  const text = () => body().textContent ?? "";
  return { dom, find, click, notify, at, text, settle };
}
