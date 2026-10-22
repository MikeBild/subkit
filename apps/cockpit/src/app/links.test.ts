import { describe, expect, test } from "bun:test";
import { openPeopleSection, readablePeopleSections } from "@/pages/admin-model";
import { openApiAccessSection, readableSections } from "@/pages/api-access-model";
import { auditFilterFromUrl } from "@/pages/audit-model";
import { connectorHealthFilterFromUrl } from "@/pages/connectors-model";
import { usageWindowFromUrl } from "@/pages/operations-figures";
import { filterFromUrl, runOverlayFromUrl } from "@/pages/runs-model";
import { settingsLeafFromUrl } from "@/pages/settings-model";
import {
  API_ACCESS_SECTIONS,
  absolute,
  apiAccessHref,
  apiAccessSectionFromUrl,
  attentionHref,
  auditHref,
  chatNewHref,
  chatSeedFromUrl,
  chatTargetFromUrl,
  connectorHref,
  connectorsHref,
  conversationHref,
  PEOPLE_SECTIONS,
  peopleAppFromUrl,
  peopleHref,
  peopleSectionFromUrl,
  recordHref,
  reviewFromUrl,
  routerPath,
  routerTarget,
  runHref,
  runsHref,
  settingsHref,
  usageHref,
  WORKFLOW_AUTOMATION_ANCHOR,
  workflowAutomationHref,
  workflowHref,
  workflowsHref,
} from "./links";

const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const query = (href: string) =>
  href.slice(href.indexOf("?") === -1 ? href.length : href.indexOf("?"));

describe("router-relative, and absolute only on request", () => {
  test("no builder carries the base the router already has", () => {
    for (const href of [
      runsHref(),
      runHref(ID),
      workflowHref(ID),
      connectorHref(ID),
      recordHref("files", ID),
      workflowsHref({ connector: "crm" }),
      conversationHref(ID),
      attentionHref(),
      attentionHref({ review: "skills" }),
      settingsHref(),
      usageHref({ window: "7d" }),
      auditHref(),
      chatNewHref(),
      apiAccessHref(),
    ]) {
      expect(href.startsWith("/")).toBe(true);
      expect(href.startsWith("/cockpit")).toBe(false);
    }
  });

  test("every record, intake items included, has its own page address", () => {
    for (const resource of [
      "workflows",
      "connectors",
      "knowledge",
      "skills",
      "files",
      "intake",
    ] as const)
      expect(recordHref(resource, ID)).toBe(`/${resource}/${ID}`);
    expect(recordHref("intake", "a b")).toBe("/intake/a%20b");
  });

  test("absolute adds the base exactly once", () => {
    expect(absolute("/runs")).toBe("/cockpit/runs");
    expect(absolute(absolute("/runs"))).toBe("/cockpit/runs");
    expect(absolute("/")).toBe("/cockpit");
  });

  test("the start page with a query keeps the router's no-trailing-slash form", () => {
    expect(absolute("/?review=skills")).toBe("/cockpit?review=skills");
    expect(absolute("/cockpit?review=skills")).toBe("/cockpit?review=skills");
    expect(absolute(absolute("/?review=skills"))).toBe("/cockpit?review=skills");
  });

  test("an engine address becomes a router path, and back again", () => {
    expect(routerPath("/cockpit")).toBe("/");
    expect(routerPath("/cockpit?review=skills")).toBe("/?review=skills");
    expect(routerPath(`/cockpit/connectors/${ID}`)).toBe(`/connectors/${ID}`);
    expect(routerPath("/runs")).toBe("/runs");
    expect(routerTarget(`/cockpit/workflows/${ID}#workflow-automation`)).toEqual({
      to: `/workflows/${ID}`,
      hash: WORKFLOW_AUTOMATION_ANCHOR,
    });
    expect(routerTarget(`/cockpit/connectors/${ID}`)).toEqual({ to: `/connectors/${ID}` });
    expect(routerTarget("/cockpit?review=skills")).toEqual({
      to: "/",
      search: { review: "skills" },
    });
    expect(routerTarget(`/cockpit?runs=all&runs_workflow=${ID}&runs_status=failed`)).toEqual({
      to: "/",
      search: { runs: "all", runs_workflow: ID, runs_status: "failed" },
    });
    const panel = routerTarget(`/cockpit/workflows/${ID}#workflow-automation`);
    expect(`${panel.to}#${panel.hash}`).toBe(workflowAutomationHref(ID));
    for (const href of ["/cockpit", "/cockpit?review=skills", `/cockpit/connectors/${ID}`])
      expect(absolute(routerPath(href))).toBe(href);
  });

  test("an id is encoded, never spliced raw into the path", () => {
    expect(workflowHref("a/b")).toBe("/workflows/a%2Fb");
  });
});

describe("runs", () => {
  test("every narrowing survives the round trip", () => {
    const href = runsHref({
      workflowId: ID,
      status: "failed",
      source: "scheduler",
      q: "Monatsreport",
      startedFrom: "2026-08-03T12:00:00.000Z",
      startedTo: "2026-08-10T12:00:00.000Z",
    });
    expect(filterFromUrl(query(href))).toEqual({
      workflowId: ID,
      status: "failed",
      source: "scheduler",
      q: "Monatsreport",
      startedFrom: "2026-08-03T12:00:00.000Z",
      startedTo: "2026-08-10T12:00:00.000Z",
    });
  });

  test("a window that is not two instants is dropped, never forwarded", () => {
    expect(filterFromUrl("?runs_from=yesterday").startedFrom).toBeNull();
    expect(filterFromUrl("?runs_to=2026-13-45T99:00:00Z").startedTo).toBeNull();
    expect(filterFromUrl("?runs_from=2026-08-03T14:00:00%2B02:00").startedFrom).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });

  test("all runs and one run open as sheets over Übersicht", () => {
    expect(runsHref()).toBe("/?runs=all");
    expect(runHref(ID)).toBe(`/?run=${ID}`);
    expect(runOverlayFromUrl(query(runsHref()))).toEqual({ list: true, runId: null });
    expect(runOverlayFromUrl(query(runHref(ID)))).toEqual({ list: false, runId: ID });
  });

  test("the list narrows with its own keys, never the page's q, status or source", () => {
    const href = runsHref({
      workflowId: ID,
      status: "failed",
      source: "scheduler",
      q: "x",
      startedFrom: "2026-08-03T12:00:00.000Z",
      startedTo: "2026-08-10T12:00:00.000Z",
    });
    expect([...new URLSearchParams(query(href)).keys()]).toEqual([
      "runs",
      "runs_workflow",
      "runs_status",
      "runs_source",
      "runs_q",
      "runs_from",
      "runs_to",
    ]);
    expect(filterFromUrl(`?q=foo&status=failed&source=api&workflow_id=${ID}`)).toEqual({
      workflowId: null,
      status: "all",
      source: "all",
      q: "",
      startedFrom: null,
      startedTo: null,
    });
  });

  test("the list's word for no narrowing is left out of the address", () => {
    expect(runsHref({ status: "all", source: "all" })).toBe("/?runs=all");
    expect(filterFromUrl(query(runsHref()))).toEqual({
      workflowId: null,
      status: "all",
      source: "all",
      q: "",
      startedFrom: null,
      startedTo: null,
    });
  });
});

describe("Übersicht", () => {
  test("the entry a link names is the review sheet the page opens", () => {
    for (const id of [`workflow:${ID}`, "skills", `connector:${ID}`, "secret-approval:mail@3"])
      expect(reviewFromUrl(query(attentionHref({ review: id })))).toBe(id);
    expect(reviewFromUrl(query(attentionHref()))).toBeNull();
    expect(reviewFromUrl("?review=<script>")).toBeNull();
  });
});

describe("audit", () => {
  test("record, request, scope and verbs all survive the round trip", () => {
    const href = auditHref({
      resourceType: "workflow",
      resourceId: ID,
      traceId: "cli-949cacce25ff4379",
      scope: "all",
      actions: ["patch_candidate.approved", "patch_candidate.rejected"],
      tsFrom: "2026-08-03T12:00:00.000Z",
      tsTo: "2026-08-10T12:00:00.000Z",
    });
    expect(auditFilterFromUrl(query(href))).toEqual({
      resourceType: "workflow",
      resourceId: ID,
      traceId: "cli-949cacce25ff4379",
      scope: "all",
      actions: ["patch_candidate.approved", "patch_candidate.rejected"],
      tsFrom: "2026-08-03T12:00:00.000Z",
      tsTo: "2026-08-10T12:00:00.000Z",
    });
  });

  test("an unnarrowed link narrows nothing", () => {
    expect(auditFilterFromUrl(query(auditHref()))).toEqual({
      resourceType: null,
      resourceId: null,
      traceId: null,
      scope: null,
      actions: [],
      tsFrom: null,
      tsTo: null,
    });
  });
});

describe("connectors", () => {
  test("the health narrowing the tile sends is the one the list reads", () => {
    expect(connectorHealthFilterFromUrl(query(connectorsHref({ health: "not_ok" })))).toBe(
      "not_ok",
    );
    expect(connectorsHref()).toBe("/connectors");
  });
});

describe("settings", () => {
  test("the leaf a link opens is the leaf the page reads", () => {
    expect(settingsLeafFromUrl(query(settingsHref("server.public_base_url")))).toBe(
      "server.public_base_url",
    );
    expect(settingsLeafFromUrl(query(settingsHref()))).toBeNull();
  });
});

describe("usage", () => {
  test("the window a link opens is the window the page reads", () => {
    for (const window of ["24h", "7d", "30d"] as const)
      expect(usageWindowFromUrl(query(usageHref({ window })))).toBe(window);
    expect(usageHref({ window: "7d" })).toBe("/usage");
    expect(usageWindowFromUrl(query(usageHref()))).toBe("7d");
    expect(usageWindowFromUrl("?window=1y")).toBe("7d");
  });
});

describe("a new conversation", () => {
  test("the prompt and the record it is about survive the round trip", () => {
    const href = chatNewHref({
      prompt: "Prüfe: Monatsreport & Umsatz",
      workflowId: ID,
      connectorId: "c-1",
      executionId: "e-1",
    });
    expect(chatSeedFromUrl(query(href))).toEqual({
      prompt: "Prüfe: Monatsreport & Umsatz",
      workflowId: ID,
      connectorId: "c-1",
      executionId: "e-1",
      intakeItemIds: [],
      references: [],
    });
  });

  test("structured references preserve only supported UUID records", () => {
    const href = chatNewHref({
      references: [
        { type: "intake_item", id: ID },
        { type: "workflow", id: ID },
        { type: "execution", id: ID },
        { type: "intake_item", id: ID },
      ],
    });
    expect(chatSeedFromUrl(query(href)).references).toEqual([
      { type: "intake_item", id: ID },
      { type: "workflow", id: ID },
      { type: "execution", id: ID },
    ]);
    expect(chatSeedFromUrl(`?references=intake_item:not-an-id,unknown:${ID}`).references).toEqual(
      [],
    );
  });

  test("a chat opened for a run creates its conversation with that run and its workflow", () => {
    const href = chatNewHref({ workflowId: ID, executionId: "e-1", prompt: "Warum?" });
    expect(chatTargetFromUrl(query(href))).toEqual({ workflow_id: ID, execution_id: "e-1" });
    expect(chatTargetFromUrl(query(chatNewHref({ prompt: "Hallo" })))).toEqual({});
  });

  test("an unseeded conversation is the bare address", () => {
    expect(chatNewHref()).toBe("/chat/new");
  });
});

describe("the remaining addresses", () => {
  test("list filters and sections are carried as query parameters", () => {
    expect(workflowsHref({ connector: "crm api" })).toBe("/workflows?connector=crm+api");
    expect(apiAccessHref("keys")).toBe("/api-access?section=keys");
  });

  test("a Zugangsdaten section survives the round trip, and nothing else is a section", () => {
    for (const section of API_ACCESS_SECTIONS) {
      const href = apiAccessHref(section);
      expect(apiAccessSectionFromUrl(href.slice(href.indexOf("?")))).toBe(section);
    }
    expect(apiAccessSectionFromUrl("?section=connections")).toBeNull();
    expect(apiAccessSectionFromUrl("")).toBeNull();
  });

  test("the tab the address names opens, and one the reader may not read falls back", () => {
    const all = readableSections({ clients: true, keys: true });
    expect(openApiAccessSection(apiAccessSectionFromUrl("?section=clients"), all)).toBe("clients");
    expect(openApiAccessSection(apiAccessSectionFromUrl("?section=keys"), all)).toBe("keys");
    expect(openApiAccessSection(apiAccessSectionFromUrl(""), all)).toBe("keys");
    expect(openApiAccessSection(apiAccessSectionFromUrl("?section=grants"), all)).toBe("keys");
    const keysOnly = readableSections({ clients: false, keys: true });
    expect(openApiAccessSection(apiAccessSectionFromUrl("?section=clients"), keysOnly)).toBe(
      "keys",
    );
  });
});

describe("Personen & Rechte", () => {
  test("every section survives the round trip; the people list is the bare address", () => {
    for (const section of PEOPLE_SECTIONS) {
      const href = peopleHref(section);
      expect(href.startsWith("/people")).toBe(true);
      const read = peopleSectionFromUrl(query(href));
      expect(read ?? "people").toBe(section);
    }
    expect(peopleHref("roles")).toBe("/people?section=roles");
    expect(peopleHref("people")).toBe("/people");
    expect(peopleHref()).toBe("/people");
  });

  test("the people list carries an app filter; other sections drop it", () => {
    const href = peopleHref("people", { app: "shop-app" });
    expect(href).toBe("/people?app=shop-app");
    expect(peopleAppFromUrl(query(href))).toBe("shop-app");
    expect(peopleHref(null, { app: "shop-app" })).toBe("/people?app=shop-app");
    expect(peopleHref("apps", { app: "shop-app" })).toBe("/people?section=apps");
    expect(peopleAppFromUrl("?app=Shop%20App")).toBeNull();
    expect(peopleAppFromUrl("?app=-shop")).toBeNull();
    expect(peopleAppFromUrl("")).toBeNull();
  });

  test("anything that is not a section is dropped, including the old permissions tab", () => {
    expect(peopleSectionFromUrl("?section=permissions")).toBeNull();
    expect(peopleSectionFromUrl("?section=keys")).toBeNull();
    expect(peopleSectionFromUrl("?section=")).toBeNull();
    expect(peopleSectionFromUrl("")).toBeNull();
  });

  test("the page opens at the named section only where the reader may read it", () => {
    const all = readablePeopleSections({ identity: true, rbac: true, settings: true });
    expect(all).toEqual(["people", "roles", "groups", "grants", "apps"]);
    const both = readablePeopleSections({ identity: true, rbac: true, settings: false });
    expect(both).toEqual(["people", "roles", "groups", "grants"]);
    expect(openPeopleSection(null, both)).toBe("people");
    expect(openPeopleSection("grants", both)).toBe("grants");
    const rbacOnly = readablePeopleSections({ identity: false, rbac: true, settings: false });
    expect(rbacOnly).toEqual(["roles", "groups", "grants"]);
    expect(openPeopleSection(null, rbacOnly)).toBe("roles");
    expect(openPeopleSection("people", rbacOnly)).toBe("roles");
    const settingsOnly = readablePeopleSections({ identity: false, rbac: false, settings: true });
    expect(settingsOnly).toEqual(["apps"]);
    expect(openPeopleSection("people", settingsOnly)).toBe("apps");
    const identityOnly = readablePeopleSections({ identity: true, rbac: false, settings: false });
    expect(identityOnly).toEqual(["people"]);
    expect(openPeopleSection("roles", identityOnly)).toBe("people");
    expect(openPeopleSection("roles", [])).toBeNull();
  });
});
