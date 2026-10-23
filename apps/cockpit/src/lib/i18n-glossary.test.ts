import { describe, expect, test } from "bun:test";
import { CATALOGS } from "@/lib/i18n";

const RETIRED_GERMAN = [
  /Reparatur/,
  /reparier/i,
  /Live-Test/,
  /Entwicklungstest/,
  /Testlauf/,
  /Ausführungsrecht/,
  /Ausführungsfreigabe/,
  /in Betrieb/i,
  /(^|[^a-zäöüß])gespeicherte Änderung/i,
  /vorbereitete Version/i,
  /Zugriff freigeben/,
  /Ausweich/,
  /(?<!Client-)\bSecret\b/,
  /\bAdmin\b/,
];

const RETIRED_ENGLISH = [
  /\brepair/i,
  /live test/i,
  /development test/i,
  /execution authority/i,
  /execution approval/i,
  /into service/i,
  /(^|[^a-z])saved change/i,
];

const STANDING_APPROVAL_VERBS = new Set([
  "authority.review.approve",
  "overview.action.approve",
  "overview.action.approveDialog",
  "permission.action.approve",
  "workflowStrip.action.grant",
]);

const offenders = (catalog: Record<string, string>, patterns: readonly RegExp[]) =>
  Object.entries(catalog)
    .filter(([, value]) => patterns.some((pattern) => pattern.test(value)))
    .map(([key, value]) => `${key}: ${value}`);

describe("approval glossary", () => {
  test("German copy uses one word per concept", () => {
    expect(offenders(CATALOGS.de, RETIRED_GERMAN)).toEqual([]);
  });

  test("English copy uses one word per concept", () => {
    expect(offenders(CATALOGS.en, RETIRED_ENGLISH)).toEqual([]);
  });

  test("Freigeben as a verb is reserved for a standing approval", () => {
    const verbs = Object.entries(CATALOGS.de)
      .filter(([, value]) => /^Freigeben/.test(value))
      .map(([key]) => key);
    expect(verbs.filter((key) => !STANDING_APPROVAL_VERBS.has(key))).toEqual([]);
  });

  test("each decision names its own verb", () => {
    expect(CATALOGS.de["chat.approval.approve"]).toBe("Einmal erlauben");
    expect(CATALOGS.en["chat.approval.approve"]).toBe("Allow once");
    expect(CATALOGS.de["prepared.approve"]).toBe("Übernehmen");
    expect(CATALOGS.en["prepared.approve"]).toBe("Apply");
    expect(CATALOGS.de["decisions.applyFix"]).toBe("Korrektur übernehmen");
    expect(CATALOGS.de["connectedClients.ungranted"]).toBe("Ohne Zugriff");
    expect(CATALOGS.en["connectedClients.ungranted"]).toBe("No access");
    for (const key of ["connectedClients.live", "connectedClients.noneGranted"] as const) {
      expect(CATALOGS.de[key]).not.toContain("Freigabe");
      expect(CATALOGS.en[key]).not.toContain("approval");
    }
    expect(CATALOGS.de["chat.liveTest.title"]).toBe("Einzellauf");
    expect(CATALOGS.de["tool.name.dryRunWorkflow"]).toBe("Probelauf eines Workflows");
    expect(CATALOGS.de["skills.rejected"]).toBe("Vorschlag abgelehnt: {name}");
  });

  test("audit names a standing approval Freigabe", () => {
    expect(CATALOGS.de["audit.action.authorityGranted"]).toBe("Freigabe erteilt");
    expect(CATALOGS.de["audit.action.authorityRevoked"]).toBe("Freigabe widerrufen");
    expect(CATALOGS.de["audit.action.authorityInherited"]).toBe("Freigabe übernommen");
    expect(CATALOGS.en["audit.action.authorityGranted"]).toBe("Approval granted");
    expect(CATALOGS.en["audit.action.authorityRevoked"]).toBe("Approval revoked");
    expect(CATALOGS.en["audit.action.authorityInherited"]).toBe("Approval carried over");
    expect(CATALOGS.de["audit.action.approvalGranted"]).not.toBe(
      CATALOGS.de["audit.action.authorityGranted"],
    );
  });

  test("retired approval keys are gone", () => {
    for (const key of [
      "authority.revoke",
      "authority.revokeTitle",
      "authority.revokeDescription",
      "authority.activateOnly",
      "authority.grantConfirmUntilRevoked",
      "authority.existing.title",
      "authority.content.title",
      "authority.report.title",
      "chat.activation.title",
      "chat.activation.singleTitle",
      "decisions.approve",
      "chat.activation.review",
    ]) {
      expect(Object.hasOwn(CATALOGS.en, key)).toBe(false);
      expect(Object.hasOwn(CATALOGS.de, key)).toBe(false);
    }
  });
});

const RETIRED_REDESIGN_GERMAN = [
  /Auf Anfrage/,
  /Abgeschaltet/,
  /Erneut anmelden/,
  /Neu verbinden/,
  /neu verbunden/,
  /Nur aktivieren/,
  /vor dem Ausführen/,
  /Freigeben…/,
  /Kurzname/,
  /Technische Details/,
  /Anfragequelle/,
  /Tool-Kette/,
  /nicht dokumentiert/,
  /Fundstück/,
  /Programmier-Assistent/,
  /Posteingang/,
  /Light logo|Mobile sheet|^Audience$/,
];

describe("redesign glossary", () => {
  test("German copy keeps one term per concept", () => {
    expect(offenders(CATALOGS.de, RETIRED_REDESIGN_GERMAN)).toEqual([]);
  });

  test("roles show their display names, never their keys", () => {
    expect(
      [
        "role.admin",
        "role.member",
        "role.enduser",
        "role.portalTokenUser",
        "role.metricsScraper",
      ].map((key) => CATALOGS.de[key as keyof typeof CATALOGS.de]),
    ).toEqual(["Administrator", "Mitglied", "Anwender", "Portal-Zugang", "Messwerte-Abruf"]);
    expect(CATALOGS.en["role.enduser"]).toBe("User");
  });

  test("each step kind has its own name; a service query and a workflow start no longer collide", () => {
    expect(CATALOGS.de["workflow.kind.request"]).toBe("Dienst abfragen");
    expect(CATALOGS.de["workflow.kind.call"]).toBe("Workflow starten");
    expect(CATALOGS.de["workflow.kind.parallel"]).toBe("Gleichzeitig");
    expect(CATALOGS.de["workflow.kind.loop"]).toBe("Wiederholen");
    expect(CATALOGS.en["workflow.kind.request"]).not.toBe(CATALOGS.en["workflow.kind.call"]);
  });

  test("a run starts on demand and a switched-off object is switched off", () => {
    expect(CATALOGS.de["workflows.trigger.request"]).toBe("Auf Abruf");
    expect(CATALOGS.de["connectorState.off"]).toBe("Ausgeschaltet");
    expect(CATALOGS.de["workflowStrip.state.paused"]).toBe("Angehalten");
    expect(CATALOGS.de["common.technical"]).toBe("Technische Angaben");
    expect(CATALOGS.de["run.environment.dev"]).toBe("Test");
  });

  test("triggers carry the glossary names in both languages", () => {
    expect(
      ["workflows.trigger.schedule", "workflows.trigger.webhook", "workflows.trigger.request"].map(
        (key) => [
          CATALOGS.de[key as keyof typeof CATALOGS.de],
          CATALOGS.en[key as keyof typeof CATALOGS.en],
        ],
      ),
    ).toEqual([
      ["Zeitplan", "Schedule"],
      ["Webhook", "Webhook"],
      ["Auf Abruf", "On demand"],
    ]);
  });

  test("German branding settings carry no untranslated English labels", () => {
    const names = new Set(["Standard", "Indigo", "Teal"]);
    const untranslated = Object.entries(CATALOGS.de)
      .filter(([key]) => key.startsWith("branding."))
      .filter(([key, value]) => CATALOGS.en[key as keyof typeof CATALOGS.en] === value)
      .filter(([, value]) => !names.has(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(untranslated).toEqual([]);
    expect(CATALOGS.de["branding.darkLogo"]).toBe("Logo für dunkles Design");
  });

  test("a number never breaks away from its percent sign", () => {
    const loose = (["de", "en"] as const).flatMap((locale) =>
      Object.entries(CATALOGS[locale])
        .filter(([, value]) => /\} %/.test(value))
        .map(([key]) => `${locale}:${key}`),
    );
    expect(loose).toEqual([]);
    expect(CATALOGS.de["usage.forecast.tight"]).toContain("{percent}\u00a0%");
  });
});
