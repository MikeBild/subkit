import { describe, expect, it } from "bun:test";
import {
  detectAuthoringIntent,
  detectConnectorAuthoringIntent,
  detectRepairIntent,
} from "./authoring-intent.ts";

describe("detectAuthoringIntent — authoring phrases", () => {
  it("matches 'build a workflow'", () => {
    expect(detectAuthoringIntent("build a workflow that fetches Stripe customers")).toBe(true);
  });

  it("matches 'create a workflow'", () => {
    expect(detectAuthoringIntent("create a workflow called daily-report")).toBe(true);
  });

  it("matches 'create workflow' (no article)", () => {
    expect(detectAuthoringIntent("create workflow for HubSpot sync")).toBe(true);
  });

  it("matches 'erstelle einen workflow' (German)", () => {
    expect(detectAuthoringIntent("erstelle einen workflow für den Tagesbericht")).toBe(true);
  });

  it("matches 'baue mir einen workflow' (German)", () => {
    expect(detectAuthoringIntent("baue mir einen workflow der Stripe daten holt")).toBe(true);
  });

  it("matches 'generate a workflow'", () => {
    expect(detectAuthoringIntent("generate a workflow that runs every morning")).toBe(true);
  });

  it("matches 'design a workflow'", () => {
    expect(detectAuthoringIntent("design a workflow with three steps")).toBe(true);
  });

  it("matches 'author a new workflow'", () => {
    expect(detectAuthoringIntent("author a new workflow for the team")).toBe(true);
  });

  it("matches noun-first phrasing", () => {
    expect(detectAuthoringIntent("a workflow I'd like to build")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(detectAuthoringIntent("BUILD a Workflow Called X")).toBe(true);
  });

  it("matches 'erzeuge einen workflow'", () => {
    expect(detectAuthoringIntent("erzeuge einen workflow der täglich läuft")).toBe(true);
  });
});

describe("detectAuthoringIntent — non-authoring phrases", () => {
  it("does NOT match 'list my workflows'", () => {
    expect(detectAuthoringIntent("list my workflows")).toBe(false);
  });

  it("does NOT match 'show me all workflows'", () => {
    expect(detectAuthoringIntent("show me all workflows")).toBe(false);
  });

  it("does NOT match 'run workflow X'", () => {
    expect(detectAuthoringIntent("run workflow X")).toBe(false);
  });

  it("does NOT match 'delete the workflow'", () => {
    expect(detectAuthoringIntent("delete the workflow")).toBe(false);
  });

  it("does NOT match 'inspect this workflow'", () => {
    expect(detectAuthoringIntent("inspect this workflow")).toBe(false);
  });

  it("does NOT match 'what workflows do I have'", () => {
    expect(detectAuthoringIntent("what workflows do I have")).toBe(false);
  });

  it("does NOT match an empty string", () => {
    expect(detectAuthoringIntent("")).toBe(false);
  });

  it("does NOT match whitespace only", () => {
    expect(detectAuthoringIntent("   \n\t  ")).toBe(false);
  });

  it("does NOT match null", () => {
    expect(detectAuthoringIntent(null)).toBe(false);
  });

  it("does NOT match undefined", () => {
    expect(detectAuthoringIntent(undefined)).toBe(false);
  });

  it("does NOT match a verb without the workflow noun", () => {
    expect(detectAuthoringIntent("build a connector for HubSpot")).toBe(false);
  });

  it("does NOT match the noun without an authoring verb", () => {
    expect(detectAuthoringIntent("my workflow")).toBe(false);
  });

  it("does NOT match 'I want to run the workflow tomorrow'", () => {
    expect(detectAuthoringIntent("I want to run the workflow tomorrow")).toBe(false);
  });

  it("does NOT match 'list my workflows that build X' (enumeration phrase)", () => {
    expect(detectAuthoringIntent("list my workflows that build X")).toBe(false);
  });

  it("does NOT match 'search workflows that build invoices'", () => {
    expect(detectAuthoringIntent("search workflows that build invoices")).toBe(false);
  });

  it("does NOT match 'build a connector for the daily-report workflow'", () => {
    expect(detectAuthoringIntent("build a connector for the daily-report workflow")).toBe(false);
  });

  it("does NOT match 'create a new connector that feeds the invoices workflow'", () => {
    expect(detectAuthoringIntent("create a new connector that feeds the invoices workflow")).toBe(
      false,
    );
  });

  it("does NOT match 'erstelle einen connector für den workflow'", () => {
    expect(detectAuthoringIntent("erstelle einen connector für den workflow")).toBe(false);
  });

  it("does not bridge a workflow noun and creation verb across sentence boundaries", () => {
    expect(
      detectAuthoringIntent(
        "Bearbeite den bestehenden Workflow als neue persistierte Workflow-Version. Erzeuge ausdrücklich keinen neuen Workflow.",
      ),
    ).toBe(false);
  });
});

describe("detectConnectorAuthoringIntent", () => {
  it("matches connector and integration creation phrasing in English and German", () => {
    expect(detectConnectorAuthoringIntent("create a connector for the Stripe API")).toBe(true);
    expect(detectConnectorAuthoringIntent("set up a new integration for HubSpot")).toBe(true);
    expect(detectConnectorAuthoringIntent("Erstelle einen Connector für unser CRM")).toBe(true);
    expect(detectConnectorAuthoringIntent("richte eine Integration für Jira ein")).toBe(true);
  });

  it("treats an external MCP server as a connector and onboarding as connector-first", () => {
    expect(detectConnectorAuthoringIntent("Connect our Metabase MCP server for reporting")).toBe(
      true,
    );
    expect(detectConnectorAuthoringIntent("verbinde den MCP-Server von Linear")).toBe(true);
    expect(detectConnectorAuthoringIntent("subkit engine onboarding")).toBe(true);
    expect(detectConnectorAuthoringIntent("list my MCP servers")).toBe(false);
    expect(detectConnectorAuthoringIntent("welche MCP-Server gibt es")).toBe(false);
    expect(detectConnectorAuthoringIntent("the server returned 500")).toBe(false);
  });

  it("rejects enumeration, negation and unrelated messages", () => {
    expect(detectConnectorAuthoringIntent("list my connectors")).toBe(false);
    expect(detectConnectorAuthoringIntent("welche Connectors habe ich?")).toBe(false);
    expect(detectConnectorAuthoringIntent("do not create a connector, just run it")).toBe(false);
    expect(detectConnectorAuthoringIntent("why did the report fail?")).toBe(false);
    expect(detectConnectorAuthoringIntent(null)).toBe(false);
  });
});

describe("detectRepairIntent", () => {
  it("matches repair and diagnosis of a workflow or run in English and German", () => {
    for (const message of [
      "repair workflow ga4-daily-report",
      "fix the failing workflow",
      "Bitte reparier den Workflow",
      "diagnose the latest execution of ga4-daily-report",
      "Warum ist mein letzter Lauf von ga4-daily-report fehlgeschlagen?",
      "why did the last run fail?",
    ]) {
      expect(detectRepairIntent(message)).toBe(true);
    }
  });

  it("rejects unrelated, negated and run-less wording", () => {
    for (const message of [
      "what failed last night?",
      "list my workflows",
      "please list users from the api",
      "do not fix the workflow",
      "fix the typo in my message",
      "Warum ist der Himmel blau?",
    ]) {
      expect(detectRepairIntent(message)).toBe(false);
    }
    expect(detectRepairIntent(null)).toBe(false);
  });
});
