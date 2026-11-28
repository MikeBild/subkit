import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const CHILD_FLAG = "SUBKIT_DATA_LINKS_CHILD";
const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const INSTALLATION = "7c1e2a90-3b4d-4f5e-8a6b-0c9d8e7f6a5b";
const BASES = ["/cockpit", `/cockpit/i/${INSTALLATION}`] as const;
const ENGINE_SRC = join(import.meta.dir, "..", "..", "..", "engine", "src");
const PUBLIC = join(import.meta.dir, "..", "..", "public");
const ENGINE_NON_PAGES = /^\/cockpit\/(?:i\/|favicon\.svg$|\{path\}$|api(?:\/|$))/;

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

function installBrowser(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/cockpit",
  });
  dom.window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    matchMedia: dom.window.matchMedia,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return dom;
}

function engineHrefs(dir = ENGINE_SRC): { file: string; href: string }[] {
  const out: { file: string; href: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") out.push(...engineHrefs(full));
      continue;
    }
    if (!/\.ts$/.test(entry.name) || entry.name.includes(".test.")) continue;
    for (const m of readFileSync(full, "utf8").matchAll(/["'`](\/cockpit(?:[/?#][^"'`\s]*)?)/g)) {
      const raw = m[1] ?? "";
      if (raw.startsWith("/cockpit/${") || ENGINE_NON_PAGES.test(raw)) continue;
      const href = raw.replace(/\$\{[^}]*\}?/g, ID).replace(/\$\{.*$/, "");
      out.push({ file: full.slice(ENGINE_SRC.length + 1), href });
    }
  }
  return out;
}

function workerNotify(): { scopedHref(href: string, base: string): string } {
  const self: Record<string, unknown> = {
    location: { origin: "http://localhost" },
    navigator: { language: "de-DE", languages: ["de-DE"] },
    registration: { scope: "http://localhost/cockpit/" },
    addEventListener() {},
  };
  vm.runInNewContext(readFileSync(join(PUBLIC, "worker-notify.js"), "utf8"), { URL, self });
  return self.subkitNotify as { scopedHref(href: string, base: string): string };
}

isolated("every link the cockpit builds from data opens a page under both base paths", async () => {
  const dom = installBrowser();
  const { router } = await import("./router");
  const links = await import("./links");
  const { CATALOG_RESOURCES, STANDALONE_ROUTES } = await import("./route-table");
  const { attentionTarget, entryActions, opensReviewSheet, reviewForward } = await import(
    "@/features/overview/model/overview-model"
  );
  const { startSteps } = await import("@/features/overview/model/overview-start-steps");
  const { conversationContext, patchContext, skillContext } = await import(
    "@/features/decisions/model/decisions-context"
  );
  const { repairReviewHref } = await import("@/features/workflows/ui/workflow-diagnosis");
  const { launchRoute } = await import("@/features/pwa/deep-link");
  const { buildNameIndex } = await import("@/lib/name-index");
  const { item } = await import("@/features/overview/model/overview-model-fixtures");

  const page = (to: string) => {
    if ((STANDALONE_ROUTES as readonly string[]).includes(to)) return to;
    const found = router.getMatchedRoutes(to)[2];
    return found && found.id !== "__root__" ? found.fullPath : null;
  };
  const dead = new Set<string>();
  const navigates = (producer: string, href: string) => {
    const target = links.routerTarget(href);
    if (!page(target.to)) dead.add(`${producer}: navigate(${href}) -> ${target.to}`);
  };
  const anchors = (producer: string, href: string) => {
    const base = links.absolute("/");
    const absolute = links.absolute(href);
    if (!(absolute === base || absolute.startsWith(`${base}/`) || absolute.startsWith(`${base}?`)))
      dead.add(`${producer}: <a href=${absolute}> leaves ${base}`);
    else if (!page(links.routerTarget(absolute).to))
      dead.add(`${producer}: <a href=${absolute}> -> ${links.routerPath(absolute)}`);
  };
  const both = (producer: string, href: string | null | undefined) => {
    if (!href) return;
    navigates(producer, href);
    anchors(producer, href);
  };

  const engine = engineHrefs();
  const producers = new Set(engine.map((entry) => entry.file.split("/").pop()));
  for (const known of [
    "attention-readers.ts",
    "ai-access-attention.ts",
    "operational-overview.ts",
    "operating-figures.ts",
  ])
    expect(producers.has(known)).toBe(true);
  const engineAttention = engine.filter((entry) => entry.file.startsWith("operator/"));
  const { ATTENTION_REASONS: reasons } = (await import(
    join(ENGINE_SRC, "operator", "core", "attention.ts")
  )) as { ATTENTION_REASONS: readonly string[] };
  expect(reasons).toContain("intake_collected");
  expect(reasons).toContain("version_needs_repair");
  const notify = workerNotify();
  const names = buildNameIndex([{ id: ID, name: "Report" }], [{ id: ID, name: "Gmail" }]);
  const labels = {
    cause: null,
    causeFallback: "c",
    failedRun: "r",
    endpoint: "e",
    workflow: "w",
    conversation: "v",
    allWorkflows: "a",
    noTarget: "n",
    pattern: "p",
    observedCases: "o",
  };
  const subjects = ["workflow", "connector", "connection", "conversation", "task"] as const;
  const verbs = ["review", "open", "chat", "reauth", "renew", "answer", "open_runs"] as const;

  for (const base of BASES) {
    dom.reconfigure({ url: `http://localhost${base}` });
    expect(links.absolute("/")).toBe(base);
    expect(links.absolute("/cockpit#top")).toBe(`${base}#top`);
    expect(links.routerTarget("/cockpit#top")).toEqual({ to: "/", hash: "top" });

    for (const entry of engine) both(`[${base}] engine ${entry.file}`, entry.href);

    for (const reason of reasons)
      for (const kind of subjects)
        for (const verb of verbs)
          for (const entry of engineAttention) {
            const attention = item({
              id: kind === "workflow" ? `workflow:${ID}` : `${kind}:${ID}`,
              reason: reason as never,
              subject: { kind, id: ID, name: "x" },
              actions: [{ verb, href: entry.href, primary: true, permission: "workflow:read" }],
            });
            const primary = entryActions(attention).primary;
            if (!primary) continue;
            const producer = `[${base}] attention ${reason} ${entry.file}`;
            if (!opensReviewSheet(attention, primary))
              navigates(producer, attentionTarget(primary, attention));
            const forward = reviewForward(primary, "nothing");
            if (forward) navigates(`${producer} review sheet`, forward.href);
            const notice = launchRoute(notify.scopedHref(entry.href, `${base}/`), base);
            navigates(`${producer} notification`, notice ?? "/");
          }

    const built: Record<string, string> = {
      runs: links.runsHref({ workflowId: ID, status: "failed" }),
      run: links.runHref(ID),
      workflow: links.workflowHref(ID),
      workflowAutomation: links.workflowAutomationHref(ID),
      workflowRun: links.workflowRunHref(ID),
      workflowHistory: links.workflowSectionHref(ID, "history"),
      workflows: links.workflowsHref({ operatingStatus: "repair_required" }),
      task: links.taskHref(ID, "runs"),
      connector: links.connectorHref(ID),
      connectors: links.connectorsHref({ health: "not_ok" }),
      conversation: links.conversationHref(ID),
      conversationMessage: links.conversationMessageHref(ID, ID),
      chatNew: links.chatNewHref({ workflowId: ID, executionId: ID }),
      docs: links.docsHref("web-clipper", "start"),
      review: links.attentionHref({ review: `workflow:${ID}` }),
      overview: links.attentionHref(),
      repairReview: repairReviewHref(ID),
      usage: links.usageHref({ window: "thisMonth" }),
      settings: links.settingsHref("server.public_base_url"),
      people: links.peopleHref("grants"),
      apiAccess: links.apiAccessHref("keys"),
      history: links.auditHref({ scope: "decisions" }),
      decided: links.auditHref({ resourceType: "patch_candidate", resourceId: ID }),
      ...Object.fromEntries(
        [...CATALOG_RESOURCES, "intake" as const].map((resource) => [
          `record:${resource}`,
          links.recordHref(resource, ID),
        ]),
      ),
    };
    for (const [name, href] of Object.entries(built)) both(`[${base}] ${name}`, href);

    const everyone = {
      permissions: [
        "connector:write",
        "conversation:write",
        "workflow:read",
        "identity:write",
        "mcp_oauth_client:read",
      ],
      start_steps: { connector: false, workflow: false, run: false, people: false, client: false },
    };
    for (const step of startSteps(everyone as never))
      both(`[${base}] first steps ${step.id}`, step.href);

    const decisions = [
      patchContext(
        {
          workflowId: ID,
          workflowName: null,
          connectorId: ID,
          endpointKey: "send",
          executionId: ID,
          environment: "prod",
          workflowStepId: null,
          gateCode: null,
          gateReason: null,
          gateStepId: null,
          fixer: null,
          driftKind: null,
        } as never,
        labels,
        names,
        true,
      ),
      skillContext(
        { scope: "workflow", workflowId: ID, connectorId: ID, endpointKey: null, evidenceCount: 2 },
        labels,
        names,
      ),
      skillContext(
        { scope: "connector", workflowId: ID, connectorId: ID, endpointKey: "x", evidenceCount: 1 },
        labels,
        names,
      ),
      conversationContext(
        { conversationId: ID, targetWorkflowId: ID, targetConnectorId: ID },
        labels,
        names,
      ),
    ];
    for (const context of decisions)
      for (const entry of [...context.sources, ...context.targets])
        if (entry.href) navigates(`[${base}] decision ${entry.label}`, entry.href);
  }

  expect([...dead]).toEqual([]);
  dom.window.close();
});

isolated(
  "the two reported overview buttons open their pages in the installed cockpit",
  async () => {
    const dom = installBrowser();
    dom.reconfigure({ url: `http://localhost/cockpit/i/${INSTALLATION}` });
    const { router } = await import("./router");
    const { routerTarget } = await import("./links");
    const intake = routerTarget("/cockpit/intake?category=all");
    const repair = routerTarget(`/cockpit/workflows/${ID}#workflow-automation`);
    expect(intake).toEqual({ to: "/intake", search: { category: "all" } });
    expect(repair).toEqual({ to: `/workflows/${ID}`, hash: "workflow-automation" });
    expect(router.getMatchedRoutes(intake.to)[2]?.fullPath).toBe("/intake");
    expect(router.getMatchedRoutes(repair.to)[2]?.fullPath).toBe("/workflows/$resourceId");
    expect(routerTarget("/cockpit?review=skills")).toEqual({
      to: "/",
      search: { review: "skills" },
    });
    dom.window.close();
  },
);
