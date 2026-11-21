import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nContext } from "@/lib/i18n-context";

const CHILD_FLAG = "SUBKIT_GRANT_PROPOSALS_DOM_CHILD";

function isolated(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env[CHILD_FLAG] !== "1") {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", name], {
        env: { ...process.env, [CHILD_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }
    await body();
  });
}

const DIGEST = "d".repeat(64);
const pinned = { digest: DIGEST, base_version_id: "version-1", draft_version_id: null };

function preview(version: string, environment: string, eligible: boolean, choice: boolean) {
  return {
    digest: "digest",
    eligible_for_repeated_runs: eligible,
    preparation_required: false,
    approval_carries_over: false,
    unavailable_steps: [],
    schedules: [],
    environments: {
      dev: { possible: true, reasons: [] },
      prod: choice
        ? { possible: true, reasons: [] }
        : {
            possible: false,
            reasons: [
              {
                code: "connector_missing",
                step_id: "read_news",
                connector_id: "11111111-1111-4111-8111-111111111111",
                connector_name: "News",
              },
            ],
          },
    },
    recommended_environment: choice
      ? { environment: "prod", reason: "started_manually" }
      : { environment: "dev", reason: "only_possible" },
    boundary_growth: [],
    suggested_bounds: { valid_from: "2026-01-01T00:00:00.000Z" },
    execution_shape: { requests: [], iterations: [] },
    request_refusals: eligible ? [] : [{ step_id: "read_news", reason: "no_boundary" }],
    storage_refusals: [],
    manifest: {
      workflow_id: "wf-grant",
      workflow_version_id: version,
      execution_environment: environment,
      effects: [],
      issues: eligible ? [] : [{ step_id: "read_news", code: "dynamic_request" }],
    },
  };
}

const proposal = {
  step_id: "read_news",
  boundary: {
    variables: { "input.lang": { enum: ["de", "en"] } },
    max_body_bytes: 0,
    max_calls: 4,
  },
  request: {
    method: "GET",
    origin: "https://api.example.test",
    segments: ["", "v1", "news"],
    variables: { "input.lang": { enum: ["de", "en"] } },
    query: { fixed: {}, variable: [{ key: "lang", var: "input.lang" }] },
    max_body_bytes: 0,
    max_calls: 4,
  },
  evidence: {
    observations: 2,
    sample: "https://api.example.test/v1/news",
    newest_at: "2026-01-01T00:00:00.000Z",
    kind: "sent",
  },
};

interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

interface Scene {
  proposals: (call: number) => unknown;
  eligibleVersions?: string[];
  prepare?: unknown;
  permissions?: string[];
  choice?: boolean;
}

async function stage(scene: Scene, props: Record<string, unknown> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  dom.window.scrollTo = () => {};
  dom.window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  const calls: Call[] = [];
  let proposalReads = 0;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    scrollTo: () => {},
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), "http://localhost");
      const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
      const text = request ? await request.clone().text() : (init?.body ?? "");
      calls.push({
        method,
        path: url.pathname,
        search: url.search,
        body: typeof text === "string" && text ? JSON.parse(text) : null,
      });
      const version = /versions\/([^/]+)\//.exec(url.pathname)?.[1] ?? "";
      if (url.pathname.endsWith("/authority-preview"))
        return json(
          preview(
            version,
            url.searchParams.get("environment") ?? "dev",
            scene.eligibleVersions?.includes(version) ?? false,
            scene.choice ?? false,
          ),
        );
      if (url.pathname.endsWith("/prepare-authority")) return json(scene.prepare ?? {});
      if (url.pathname.endsWith("/boundary-proposals/apply"))
        return json({ draft: { version_id: "version-2" }, applied_step_ids: ["read_news"] });
      if (url.pathname.endsWith("/boundary-proposals")) {
        proposalReads += 1;
        return json(scene.proposals(proposalReads));
      }
      if (url.pathname.endsWith("/history"))
        return json({ items: [{ id: "version-1", version: 1 }], total: 1 });
      if (url.pathname.endsWith("/v1/workflows/wf-grant"))
        return json({ name: "Daily report", draft_version_id: null, current_version: 1 });
      return json({ items: [], total: 0, diagnoses: [] });
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const session = await import("@/app/session");
  mock.module("@/app/session", () => ({
    ...session,
    useSession: () => ({
      permissions: scene.permissions ?? [
        "workflow:read",
        "workflow:run",
        "workflow:write",
        "execution:read",
      ],
    }),
  }));
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@ui/molecules/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const { GrantWorkflowAuthority } = await import("./grant-workflow-authority");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root: Root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  const find = (id: string) =>
    dom.window.document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const turn = () =>
    act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  const until = async (ready: () => boolean) => {
    for (let round = 0; round < 20_000 && !ready(); round++) await turn();
    expect(ready()).toBe(true);
  };
  const shown = (id: string) => until(() => find(id) !== null);
  const click = async (id: string) => {
    await shown(id);
    await act(async () => {
      find(id)?.click();
    });
  };
  const mount = (versionId: string, more: Record<string, unknown> = {}, instance = "page") =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue("en")}>
            <TooltipProvider>
              <GrantWorkflowAuthority
                key={instance}
                workflowId="wf-grant"
                versionId={versionId}
                {...props}
                {...more}
              />
            </TooltipProvider>
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
  await mount("version-1");
  return {
    calls,
    find,
    click,
    shown,
    until,
    mount,
    unmount: () =>
      act(async () => {
        root.render(<QueryClientProvider client={client}>{null}</QueryClientProvider>);
      }),
    async idle() {
      for (let round = 0; round < 500; round++) await turn();
    },
    text: (id: string) => find(id)?.textContent ?? null,
    async close() {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

isolated("the suggested limits are listed in plain words before anything is written", async () => {
  const dialog = await stage({
    proposals: () => ({
      proposals: [proposal],
      unproposable: [{ step_id: "send_mail", reason: "still_refused", refusal: "runtime_header" }],
      ...pinned,
    }),
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.shown("authority-repair");
    await dialog.shown("authority-repair-creates");
    const row = dialog.text("authority-proposal-read_news") ?? "";
    expect(row).toContain("Read news");
    expect(row).toContain("Read from a fixed address");
    expect(row).toContain("Address: api.example.test");
    expect(row).toContain("Lang may only be: de, en");
    expect(row).toContain("Sends no content.");
    expect(row).not.toContain("input.lang");
    expect(dialog.text("authority-proposals-technical")).not.toContain("input.lang");
    await dialog.click("authority-proposals-technical-toggle");
    await dialog.until(() =>
      (dialog.text("authority-proposals-technical") ?? "").includes("input.lang"),
    );
    expect(dialog.text("authority-proposals-technical")).toContain(
      "GET https://api.example.test/v1/news?lang={input.lang}",
    );
    expect(dialog.text("authority-proposals-summary")).toContain("1 step");
    expect(dialog.text("authority-proposals-listed")).toBe(
      "The values listed here are saved in the workflow, so check them before you approve it.",
    );
    expect(dialog.text("authority-repair-remaining")).toContain("1 step needs a change");
    expect(dialog.text("authority-proposal-reason-send_mail")).toContain("Send mail");
    expect(dialog.text("authority-repair-creates")).toContain("v2");
    expect(dialog.find("authority-repair-apply")).not.toBeNull();
    expect(dialog.find("authority-proposals-trial")).toBeNull();
    const read = dialog.calls.find((call) => call.path.endsWith("/boundary-proposals"));
    expect(read?.search).toBe("?environment=dev");
    expect(dialog.calls.some((call) => call.method === "POST")).toBe(false);
  } finally {
    await dialog.close();
  }
});

isolated("with nothing to suggest the reasons are shown instead of an empty section", async () => {
  const dialog = await stage({
    proposals: () => ({
      proposals: [],
      unproposable: [
        { step_id: "by_token", reason: "sensitive_value" },
        { step_id: "odd_path", reason: "path_not_comparable" },
      ],
      ...pinned,
    }),
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.shown("authority-repair");
    expect(dialog.text("authority-repair-remaining")).toContain("2 steps need a change");
    expect(dialog.text("authority-proposal-reason-by_token")).toContain(
      "puts a secret into its address",
    );
    expect(dialog.text("authority-proposal-reason-odd_path")).toContain("in the chat");
    expect(dialog.find("authority-proposals-summary")).toBeNull();
    expect(dialog.find("authority-repair-apply")).toBeNull();
    expect(dialog.find("authority-proposals-trial")).toBeNull();
    expect(dialog.find("authority-adjust")).not.toBeNull();
  } finally {
    await dialog.close();
  }
});

isolated(
  "applying sends what was previewed and continues with the review of the new version",
  async () => {
    const dialog = await stage({
      proposals: (call) =>
        call === 1 ? { proposals: [proposal], unproposable: [], ...pinned } : { ...pinned },
      eligibleVersions: ["version-2"],
    });
    try {
      await dialog.click("authority-grant-open");
      await dialog.click("authority-repair-apply");
      await dialog.shown("authority-grant-confirm");
      const applied = dialog.calls.find((call) => call.path.endsWith("/boundary-proposals/apply"));
      expect(applied?.method).toBe("POST");
      expect(applied?.body).toEqual({
        base_version_id: "version-1",
        proposals_digest: DIGEST,
        step_ids: ["read_news"],
        environment: "dev",
      });
      const reviewed = dialog.calls.filter((call) => call.path.endsWith("/authority-preview"));
      expect(reviewed.at(-1)?.path).toContain("/versions/version-2/");
      expect(dialog.find("authority-grant-dialog")).not.toBeNull();
      expect(dialog.find("authority-repair")).toBeNull();
    } finally {
      await dialog.close();
    }
  },
);

const untried = { proposals: [], unproposable: [{ step_id: "read_news", reason: "no_history" }] };

isolated(
  "a step without history gets one trial run, and the limits appear when it is done",
  async () => {
    const dialog = await stage({
      proposals: (call) =>
        call === 1
          ? { ...untried, ...pinned }
          : { proposals: [proposal], unproposable: [], ...pinned },
      prepare: { prepared: true },
    });
    try {
      await dialog.click("authority-grant-open");
      await dialog.shown("authority-proposals-untried");
      expect(dialog.text("authority-proposals-untried")).toContain("start a trial run");
      expect(dialog.find("authority-repair-apply")).toBeNull();
      expect(dialog.calls.some((call) => call.path.endsWith("/prepare-authority"))).toBe(false);
      await dialog.click("authority-proposals-trial");
      await dialog.shown("authority-proposal-read_news");
      const trial = dialog.calls.find((call) => call.path.endsWith("/prepare-authority"));
      expect(trial?.method).toBe("POST");
      expect(trial?.path).toContain("/versions/version-1/");
      expect(trial?.body).toEqual({ environment: "dev" });
      expect(dialog.find("authority-repair-apply")).not.toBeNull();
      expect(dialog.find("authority-proposals-trial")).toBeNull();
      expect(dialog.find("authority-proposals-trial-none")).toBeNull();
    } finally {
      await dialog.close();
    }
  },
);

isolated("every click on the trial action starts a run, also right after another", async () => {
  const dialog = await stage({
    proposals: () => ({ ...untried, ...pinned }),
    prepare: { prepared: true },
  });
  try {
    await dialog.click("authority-grant-open");
    const runs = () =>
      dialog.calls.filter((call) => call.path.endsWith("/prepare-authority")).length;
    await dialog.click("authority-proposals-trial");
    await dialog.until(() => runs() === 1);
    await dialog.click("authority-proposals-trial");
    await dialog.until(() => runs() === 2);
  } finally {
    await dialog.close();
  }
});

isolated("a trial the engine does not start is said, never passed over in silence", async () => {
  const dialog = await stage({
    proposals: () => ({ ...untried, ...pinned }),
    prepare: { prepared: false, reason: "nothing_to_prepare" },
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.click("authority-proposals-trial");
    await dialog.shown("authority-proposals-trial-none");
    expect(dialog.text("authority-proposals-trial-none")).toContain("did not start");
  } finally {
    await dialog.close();
  }
});

isolated("without the right to run, the trial action is not offered at all", async () => {
  const dialog = await stage({
    proposals: () => ({ ...untried, ...pinned }),
    permissions: ["workflow:read", "workflow:write", "execution:read"],
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.shown("authority-proposals-untried");
    expect(dialog.find("authority-proposals-trial")).toBeNull();
  } finally {
    await dialog.close();
  }
});

isolated(
  "when the page hands the open dialog the saved version, the review continues there in the same environment",
  async () => {
    const dialog = await stage(
      {
        proposals: (call) =>
          call === 1 ? { proposals: [proposal], unproposable: [], ...pinned } : { ...pinned },
        eligibleVersions: ["version-2"],
        choice: true,
      },
      { initialEnvironment: "dev" },
    );
    try {
      await dialog.click("authority-grant-open");
      await dialog.click("authority-repair-apply");
      await dialog.until(() =>
        dialog.calls.some((call) => call.path.endsWith("/boundary-proposals/apply")),
      );
      const applied = dialog.calls.findIndex((call) =>
        call.path.endsWith("/boundary-proposals/apply"),
      );
      await dialog.mount("version-2", { initialEnvironment: "prod" });
      await dialog.idle();
      await dialog.shown("authority-grant-dialog");
      await dialog.shown("authority-grant-confirm");
      const reviews = dialog.calls
        .slice(applied)
        .filter((call) => call.path.endsWith("/authority-preview"));
      expect(reviews.length).toBeGreaterThan(0);
      for (const call of reviews) {
        expect(call.path).toContain("/versions/version-2/");
        expect(call.search).toBe("?environment=dev");
      }
      await dialog.mount("version-3");
      await dialog.idle();
      expect(dialog.find("authority-grant-dialog")).toBeNull();
    } finally {
      await dialog.close();
    }
  },
);

isolated("a new dialog for the saved version starts closed, no request is left over", async () => {
  const dialog = await stage({
    proposals: (call) =>
      call === 1 ? { proposals: [proposal], unproposable: [], ...pinned } : { ...pinned },
    eligibleVersions: ["version-2"],
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.click("authority-repair-apply");
    await dialog.until(() =>
      dialog.calls.some((call) => call.path.endsWith("/boundary-proposals/apply")),
    );
    await dialog.mount("version-2", {}, "another page");
    await dialog.idle();
    expect(dialog.find("authority-grant-dialog")).toBeNull();
    await dialog.mount("version-2", {}, "a third page");
    await dialog.idle();
    expect(dialog.find("authority-grant-dialog")).toBeNull();
  } finally {
    await dialog.close();
  }
});

isolated("a version changed by someone else closes the open review", async () => {
  const dialog = await stage({ proposals: () => ({ ...pinned }), eligibleVersions: ["version-1"] });
  try {
    await dialog.click("authority-grant-open");
    await dialog.shown("authority-grant-confirm");
    await dialog.mount("version-9");
    await dialog.idle();
    expect(dialog.find("authority-grant-dialog")).toBeNull();
    const before = dialog.calls.length;
    await dialog.click("authority-grant-open");
    await dialog.until(() =>
      dialog.calls.slice(before).some((call) => call.path.endsWith("/authority-preview")),
    );
    for (const call of dialog.calls.slice(before))
      if (call.path.endsWith("/authority-preview"))
        expect(call.path).toContain("/versions/version-9/");
  } finally {
    await dialog.close();
  }
});

isolated("a review closed in place does not open again on a later mount", async () => {
  const dialog = await stage({
    proposals: (call) =>
      call === 1 ? { proposals: [proposal], unproposable: [], ...pinned } : { ...pinned },
    eligibleVersions: ["version-2"],
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.click("authority-repair-apply");
    await dialog.shown("authority-grant-confirm");
    await dialog.click("authority-grant-cancel");
    await dialog.until(() => dialog.find("authority-grant-dialog") === null);
    await dialog.mount("version-2");
    await dialog.idle();
    expect(dialog.find("authority-grant-dialog")).toBeNull();
  } finally {
    await dialog.close();
  }
});

isolated("a dialog that goes away for good leaves nothing behind for the next visit", async () => {
  const dialog = await stage({
    proposals: (call) =>
      call === 1 ? { proposals: [proposal], unproposable: [], ...pinned } : { ...pinned },
    eligibleVersions: ["version-2"],
  });
  try {
    await dialog.click("authority-grant-open");
    await dialog.click("authority-repair-apply");
    await dialog.shown("authority-grant-confirm");
    await dialog.unmount();
    await dialog.idle();
    await dialog.mount("version-2");
    await dialog.idle();
    expect(dialog.find("authority-grant-dialog")).toBeNull();
  } finally {
    await dialog.close();
  }
});

isolated("without a handover the dialog stays closed until it is opened", async () => {
  const dialog = await stage({ proposals: () => ({ ...pinned }) });
  try {
    await dialog.idle();
    expect(dialog.find("authority-grant-dialog")).toBeNull();
  } finally {
    await dialog.close();
  }
});
