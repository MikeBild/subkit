import { expect } from "bun:test";
import vm from "node:vm";
import { missingProdCredential, PROD_CONNECTOR } from "@/app/credential-journey-fixtures";
import { workerSource } from "@/features/pwa/worker-fixture";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  INSTALLATION_BASE as BASE,
  BASE_PERMISSIONS,
  type Handler,
  INTAKE,
  intakeEntry,
  journeys,
  mount,
  NOW,
  RUN,
  runDetail,
  WORKFLOW,
  workflow,
} from "./journey-fixtures";

const isolated = journeys(import.meta.path);
const de = (key: TranslationKey) => translate("de", key);

function scopedNotification(href: string): string {
  const self: Record<string, unknown> = {
    location: { origin: "http://localhost" },
    navigator: { language: "de-DE", languages: ["de-DE"] },
    registration: { scope: `http://localhost${BASE}/` },
    addEventListener() {},
  };
  vm.runInNewContext(workerSource("installation-worker.js"), { URL, self });
  return (self.subkitNotify as { scopedHref(value: string, base: string): string }).scopedHref(
    href,
    `${BASE}/`,
  );
}

isolated("Overview › Review opens the inbox with the collected entries", async () => {
  const app = await mount("/");
  expect(app.find("attention-item-0-primary")?.textContent).toBe(de("overview.action.review"));
  await app.click("attention-item-0-primary");
  app.at("/intake");
  expect(app.dom.window.location.search).toBe("?category=all");
  expect(app.find("knowledge-inbox")).not.toBeNull();
  expect(app.text()).toContain(intakeEntry.title);
});

isolated("Overview › Fix opens the workflow at its repair", async () => {
  const app = await mount("/");
  expect(app.find("attention-item-1-primary")?.textContent).toBe(de("overview.action.fix"));
  await app.click("attention-item-1-primary");
  app.at(`/workflows/${WORKFLOW}`);
  expect(app.dom.window.location.hash).toBe("#workflow-automation");
  expect(app.text()).toContain(workflow.name);
  expect(app.find("workflow-diagnosis")).not.toBeNull();
});

isolated("Inbox › an entry opens for review", async () => {
  const app = await mount("/intake");
  app.at("/intake");
  await app.click("kn-row");
  app.at(`/intake/${INTAKE}`);
  expect(app.text()).toContain(intakeEntry.title);
});

isolated("a workflow that needs a fix › the repair view names the blocked step", async () => {
  const app = await mount("/workflows?operating_status=repair_required");
  app.at("/workflows");
  await app.click("data-table-row-link-0");
  app.at(`/workflows/${WORKFLOW}`);
  expect(app.find("workflow-diagnosis")?.textContent).toContain("send");
});

isolated("Fix › a missing production credential opens that connector's credentials", async () => {
  const app = await mount(`/workflows/${WORKFLOW}#workflow-automation`, {
    routes: missingProdCredential(WORKFLOW),
    permissions: [...BASE_PERMISSIONS, "connector:write"],
  });
  app.at(`/workflows/${WORKFLOW}`);
  expect(app.find("workflow-diagnosis")?.textContent).toContain("fetch_beta_group");
  expect(app.find("workflow-diagnosis-0-reconnect")?.textContent).toBe(
    de("connectorStrip.action.enterCredentials"),
  );
  expect(app.find("workflow-diagnosis-0-chat")).toBeNull();
  await app.click("workflow-diagnosis-0-reconnect");
  app.at(`/connectors/${PROD_CONNECTOR}`);
  expect(app.dom.window.location.hash).toBe("#connector-credentials");
  expect(app.text()).toContain("App Store Connect");
  expect(app.find("connector-credentials")).not.toBeNull();
  await app.click("connector-credential-replace");
  expect(app.find("connector-credential-save")).not.toBeNull();
  app.at(`/connectors/${PROD_CONNECTOR}`);
});

isolated("a notification click opens its target in the open cockpit", async () => {
  const app = await mount("/");
  await app.notify(scopedNotification("/cockpit/intake?category=all"));
  app.at("/intake");
  expect(app.text()).toContain(intakeEntry.title);
  await app.notify(scopedNotification(`/cockpit/workflows/${WORKFLOW}#workflow-automation`));
  app.at(`/workflows/${WORKFLOW}`);
  expect(app.find("workflow-diagnosis")).not.toBeNull();
});

isolated("a notification click opens its target in a new cockpit window", async () => {
  const target = scopedNotification("/cockpit/intake?category=all");
  expect(target).toBe(`${BASE}/intake?category=all`);
  const app = await mount(target.slice(BASE.length));
  app.at("/intake");
  expect(app.text()).toContain(intakeEntry.title);
});

isolated("All runs › a run opens its detail", async () => {
  const app = await mount("/");
  await app.click("overview-all-runs");
  await app.click("data-table-row-link-0");
  app.at(`/runs/${RUN}`);
  expect(app.text()).toContain(runDetail.result_markdown);
});

const invocation = {
  http: { path: "/v1/executions", body: {} },
  mcp: {},
  cli: {},
  input: { sample: {} },
  output: {},
  authority: {},
  visibility: { hooks: true, schedules: true },
  webhook_input_shape: {},
  schedules: [],
  hooks: [],
};

function costProjection(overrides: Record<string, unknown> = {}) {
  return {
    state: "estimated",
    basis: "version",
    runs_sampled: 12,
    runs_per_month: 30.42,
    per_run_amount: 0.138,
    monthly_amount: 4.2,
    currency: "EUR",
    unpriced_models: [],
    rates_basis: "current",
    ...overrides,
  };
}

const scheduleEntry = {
  id: "66666666-6666-4666-8666-666666666666",
  workflow_id: WORKFLOW,
  admission_hold: null,
  input_error: null,
  workflow_slug: workflow.slug,
  workflow_name: workflow.name,
  prepared_version_id: null,
  cron: "0 8 * * *",
  timezone: "Europe/Berlin",
  execution_mode: "prod",
  paused: false,
  auto_pause: null,
  input: null,
  created_at: NOW,
  cost_projection: costProjection(),
};

const SCHEDULE_ROUTES: Record<string, Handler> = {
  [`/v1/workflows/${WORKFLOW}/invocation`]: () => invocation,
  [`/v1/workflows/${WORKFLOW}/input-schema`]: () => ({ schema: null }),
};

const euros = (amount: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(amount);
const perMonth = (amount: number) =>
  translate("de", "schedule.cost.amount", { amount: euros(amount) });

isolated("a scheduled workflow › the schedule shows its monthly estimate", async () => {
  const app = await mount(`/workflows/${WORKFLOW}#workflow-section-use`, {
    routes: {
      ...SCHEDULE_ROUTES,
      "/v1/schedules": () => ({ schedules: [scheduleEntry], total: 1 }),
    },
  });
  await app.click("workflow-invocation-tab-schedule");
  const fact = app.find("schedule-cost-fact")?.textContent ?? "";
  expect(fact).toContain(perMonth(4.2));
  expect(fact).toContain(translate("de", "schedule.cost.basis.version.other", { count: 12 }));
});

isolated("a new schedule › the estimate follows the chosen rhythm", async () => {
  const app = await mount(`/workflows/${WORKFLOW}#workflow-section-use`, {
    routes: {
      ...SCHEDULE_ROUTES,
      [`/v1/workflows/${WORKFLOW}/schedule-cost`]: (url) =>
        costProjection({
          runs_per_month: url.searchParams.get("cron")?.endsWith("* * *") ? 30.42 : 4.33,
          monthly_amount: url.searchParams.get("cron")?.endsWith("* * *") ? 4.2 : 0.6,
        }),
    },
  });
  await app.click("workflow-invocation-tab-schedule");
  await app.click("schedule-create");
  await app.settle(80);
  expect(app.find("schedule-cost-preview")?.textContent).toContain(perMonth(4.2));
  await app.click("schedule-rhythm-weekly");
  await app.settle(80);
  expect(app.find("schedule-cost-preview")?.textContent).toContain(perMonth(0.6));
  expect(app.seen.filter((call) => call.includes("/schedule-cost?")).length).toBeGreaterThan(1);
});

isolated("A run result › the changed record opens in its source system", async () => {
  const app = await mount(`/runs/${RUN}`, {
    routes: {
      [`/v1/executions/${RUN}`]: () => ({
        ...runDetail,
        record_links: [
          {
            label: "acme/app#42",
            url: "https://github.com/acme/app/issues/42",
            connector: "github",
            connector_name: "GitHub",
            step_key: "send",
          },
        ],
      }),
    },
  });
  app.at(`/runs/${RUN}`);
  const open = app.find("run-detail-result-card-open-0");
  expect(open?.textContent).toContain(translate("de", "runs.result.view", { system: "GitHub" }));
  expect(open?.getAttribute("href")).toBe("https://github.com/acme/app/issues/42");
  expect(open?.getAttribute("target")).toBe("_blank");
  expect(open?.getAttribute("rel")).toContain("noopener");
  expect(app.find("run-detail-result-card-details")).toBeNull();
  await app.click("run-detail-result-card-details-toggle");
  expect(app.find("run-detail-result-card-record-0")?.textContent).toContain("acme/app#42");
});
