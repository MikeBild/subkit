import { expect } from "bun:test";
import vm from "node:vm";
import { missingProdCredential, PROD_CONNECTOR } from "@/app/credential-journey-fixtures";
import { workerSource } from "@/features/pwa/worker-fixture";
import { de, journeys, mount } from "./journey-fixtures";
import {
  INSTALLATION_BASE as BASE,
  BASE_PERMISSIONS,
  INTAKE,
  intakeEntry,
  RUN,
  runDetail,
  WORKFLOW,
  workflow,
} from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

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
  expect(open?.textContent).toContain(de("runs.result.view", { system: "GitHub" }));
  expect(open?.getAttribute("href")).toBe("https://github.com/acme/app/issues/42");
  expect(open?.getAttribute("target")).toBe("_blank");
  expect(open?.getAttribute("rel")).toContain("noopener");
  expect(app.find("run-detail-result-card-details")).toBeNull();
  await app.click("run-detail-result-card-details-toggle");
  expect(app.find("run-detail-result-card-record-0")?.textContent).toContain("acme/app#42");
});
