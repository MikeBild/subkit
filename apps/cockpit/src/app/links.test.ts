// Every builder, held against the parser its page reads the address back with.
//
// A parameter the link sends and the page drops is indistinguishable from no
// filter at all, so a builder is only right when its own page understands it.
// `link-targets.test.ts` proves each address leads to a page; this proves the
// page reads what the address says.

import { describe, expect, test } from "bun:test";
import { settingsLeafFromUrl } from "@/pages/admin-model";
import { auditFilterFromUrl } from "@/pages/audit-model";
import { connectorHealthFilterFromUrl } from "@/pages/connectors-model";
import { filterFromUrl } from "@/pages/runs-model";
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
  recordHref,
  reviewFromUrl,
  routerPath,
  runHref,
  runsHref,
  settingsHref,
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
    });
    expect(filterFromUrl(query(href))).toEqual({
      workflowId: ID,
      status: "failed",
      source: "scheduler",
      q: "Monatsreport",
    });
  });

  test("the page's word for no narrowing is left out of the address", () => {
    expect(runsHref({ status: "all", source: "all" })).toBe("/runs");
    expect(filterFromUrl(query(runsHref()))).toEqual({
      workflowId: null,
      status: "all",
      source: "all",
      q: "",
    });
  });
});

describe("Heute", () => {
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
    });
    expect(auditFilterFromUrl(query(href))).toEqual({
      resourceType: "workflow",
      resourceId: ID,
      traceId: "cli-949cacce25ff4379",
      scope: "all",
      actions: ["patch_candidate.approved", "patch_candidate.rejected"],
    });
  });

  test("an unnarrowed link narrows nothing", () => {
    expect(auditFilterFromUrl(query(auditHref()))).toEqual({
      resourceType: null,
      resourceId: null,
      traceId: null,
      scope: null,
      actions: [],
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
});
