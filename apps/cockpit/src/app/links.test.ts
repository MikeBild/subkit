// Every builder, held against the parser its page reads the address back with.
//
// A parameter the link sends and the page drops is indistinguishable from no
// filter at all, so a builder is only right when its own page understands it.
// `link-targets.test.ts` proves each address leads to a page; this proves the
// page reads what the address says.

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
  connectorHref,
  connectorsHref,
  conversationHref,
  PEOPLE_SECTIONS,
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

  test("absolute adds the base exactly once", () => {
    // The shipped defect: `/cockpit/cockpit/runs`.
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
    // A fragment is not part of the path: the router takes it apart.
    expect(routerTarget(`/cockpit/workflows/${ID}#workflow-automation`)).toEqual({
      to: `/workflows/${ID}`,
      hash: WORKFLOW_AUTOMATION_ANCHOR,
    });
    expect(routerTarget(`/cockpit/connectors/${ID}`)).toEqual({ to: `/connectors/${ID}` });
    expect(routerTarget("/cockpit?review=skills")).toEqual({
      to: "/",
      search: { review: "skills" },
    });
    // The run sheets live in the query; a query inside `to` would never open them.
    expect(routerTarget(`/cockpit?runs=all&workflow_id=${ID}&status=failed`)).toEqual({
      to: "/",
      search: { runs: "all", workflow_id: ID, status: "failed" },
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
    expect(filterFromUrl("?started_from=yesterday").startedFrom).toBeNull();
    expect(filterFromUrl("?started_to=2026-13-45T99:00:00Z").startedTo).toBeNull();
    // An offset is taken and said in UTC, the way the engine is asked.
    expect(filterFromUrl("?started_from=2026-08-03T14:00:00%2B02:00").startedFrom).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });

  test("all runs and one run open as sheets over Übersicht", () => {
    expect(runsHref()).toBe("/?runs=all");
    expect(runHref(ID)).toBe(`/?run=${ID}`);
    expect(runOverlayFromUrl(query(runsHref()))).toEqual({ list: true, runId: null });
    expect(runOverlayFromUrl(query(runHref(ID)))).toEqual({ list: false, runId: ID });
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
    // A value that could not be an entry id opens nothing.
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
    // Thirty days is the page's default and is left out of the address.
    expect(usageHref({ window: "30d" })).toBe("/usage");
    expect(usageWindowFromUrl(query(usageHref()))).toBe("30d");
    expect(usageWindowFromUrl("?window=1y")).toBe("30d");
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
    });
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
    // The retired section is no address any more: it opens the first tab.
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
      // The default needs no parameter: the bare address reads back as none
      // and opens at the people list.
      expect(read ?? "people").toBe(section);
    }
    expect(peopleHref("roles")).toBe("/people?section=roles");
    expect(peopleHref("people")).toBe("/people");
    expect(peopleHref()).toBe("/people");
  });

  test("anything that is not a section is dropped, including the old permissions tab", () => {
    expect(peopleSectionFromUrl("?section=permissions")).toBeNull();
    expect(peopleSectionFromUrl("?section=keys")).toBeNull();
    expect(peopleSectionFromUrl("?section=")).toBeNull();
    expect(peopleSectionFromUrl("")).toBeNull();
  });

  test("the page opens at the named section only where the reader may read it", () => {
    const both = readablePeopleSections({ identity: true, rbac: true });
    expect(both).toEqual(["people", "roles", "groups", "grants"]);
    expect(openPeopleSection(null, both)).toBe("people");
    expect(openPeopleSection("grants", both)).toBe("grants");
    // Rights only: no people list, and the default is the first readable one.
    const rbacOnly = readablePeopleSections({ identity: false, rbac: true });
    expect(rbacOnly).toEqual(["roles", "groups", "grants"]);
    expect(openPeopleSection(null, rbacOnly)).toBe("roles");
    expect(openPeopleSection("people", rbacOnly)).toBe("roles");
    // The directory only: roles and grants are absent, not failed loads.
    const identityOnly = readablePeopleSections({ identity: true, rbac: false });
    expect(identityOnly).toEqual(["people"]);
    expect(openPeopleSection("roles", identityOnly)).toBe("people");
    expect(openPeopleSection("roles", [])).toBeNull();
  });
});
