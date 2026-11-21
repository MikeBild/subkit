import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { de as uiGerman } from "@ui/i18n/de";
import { en as uiEnglish } from "@ui/i18n/en";
import { CATALOGS } from "@/lib/i18n";

const ROOT = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));

function flatten(value: unknown, path: string, out: Record<string, string>): void {
  if (typeof value === "string") out[path] = value;
  else if (typeof value === "function") {
    const text = (value as (...args: unknown[]) => unknown)(1, 2, "x");
    if (typeof text === "string") out[path] = text;
  } else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value))
      flatten(child, path ? `${path}.${key}` : key, out);
}

const DESKTOP_ENTRY =
  /"([\w.-]+)":\s*\{\s*de:\s*(["`])((?:\\.|(?!\2)[\s\S])*)\2,\s*en:\s*(["`])((?:\\.|(?!\4)[\s\S])*)\4/g;

function desktopCatalog(file: string, locale: "de" | "en"): Record<string, string> {
  const source = readFileSync(join(ROOT, file), "utf8");
  const out: Record<string, string> = {};
  for (const match of source.matchAll(DESKTOP_ENTRY)) {
    const text = locale === "de" ? match[3] : match[5];
    if (match[1] && text !== undefined) out[`${file}:${match[1]}`] = text;
  }
  return out;
}

const DESKTOP_FILES = ["apps/desktop/src/shared/i18n.ts", "apps/desktop/src/shared/shell-i18n.ts"];
const flat = (dict: unknown) => {
  const out: Record<string, string> = {};
  flatten(dict, "ui", out);
  return out;
};
const UI_GERMAN = flat(uiGerman);
const DESKTOP_GERMAN = Object.assign({}, ...DESKTOP_FILES.map((f) => desktopCatalog(f, "de")));
const DESKTOP_ENGLISH = Object.assign({}, ...DESKTOP_FILES.map((f) => desktopCatalog(f, "en")));
const ALL_GERMAN: Record<string, string> = { ...CATALOGS.de, ...UI_GERMAN, ...DESKTOP_GERMAN };
const ALL_ENGLISH: Record<string, string> = {
  ...CATALOGS.en,
  ...flat(uiEnglish),
  ...DESKTOP_ENGLISH,
};

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

const TERM_TOKEN = /[A-Za-zÄÖÜäöüß]*(?:[Ll]auf|[Ll]äuf|[Kk]onnektor)[A-Za-zÄÖÜäöüß]*/g;
const EVERYDAY_LAUF =
  /^(?:läuft|laufen|laufend\w*|laufe|gelaufen|abgelaufen\w*|durchläuft|\w*verlauf\w*|\w*ablauf\w*|\w*abläufe\w*|laufzeit\w*|\w*aufruf\w*|laufwerk\w*)$/i;

function englishTermOffenders(catalog: Record<string, string>): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    [...value.matchAll(TERM_TOKEN)]
      .map((match) => match[0])
      .filter((word) => /onnektor/i.test(word) || !EVERYDAY_LAUF.test(word))
      .map((word) => `${key}: ${word}`),
  );
}

const offenders = (catalog: Record<string, string>, patterns: readonly RegExp[]) =>
  Object.entries(catalog)
    .filter(([, value]) => patterns.some((pattern) => pattern.test(value)))
    .map(([key, value]) => `${key}: ${value}`);

describe("approval glossary", () => {
  test("German copy uses one word per concept", () => {
    expect(offenders(ALL_GERMAN, RETIRED_GERMAN)).toEqual([]);
  });

  test("English copy uses one word per concept", () => {
    expect(offenders(ALL_ENGLISH, RETIRED_ENGLISH)).toEqual([]);
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
    expect(CATALOGS.de["chat.liveTest.title"]).toBe("Einzel-Run");
    expect(CATALOGS.de["tool.name.dryRunWorkflow"]).toBe("Probe-Run eines Workflows");
    expect(CATALOGS.de["skills.rejected"]).toBe("Vorschlag verworfen: {name}");
    expect(CATALOGS.de["skills.reject"]).toBe("Verwerfen");
    expect(CATALOGS.en["skills.reject"]).toBe("Discard");
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
  /Auf Abruf/,
  /Nicht freigegeben/,
  /Freigabe nötig/,
  /Sitzungsrichtlinie/,
  /Prüfverfahren unbekannt/,
  /Weiterer Vorgang/,
];

describe("redesign glossary", () => {
  test("German copy keeps one term per concept", () => {
    expect(offenders(ALL_GERMAN, RETIRED_REDESIGN_GERMAN)).toEqual([]);
  });

  test("the shared UI and desktop catalogs are part of the check", () => {
    expect(UI_GERMAN["ui.err.cases.reauth.body"]).toContain("Connector");
    expect(Object.keys(UI_GERMAN).length).toBeGreaterThan(50);
    expect(DESKTOP_GERMAN["apps/desktop/src/shared/i18n.ts:tray.open"]).toBe("SubKit öffnen");
    expect(DESKTOP_GERMAN["apps/desktop/src/shared/shell-i18n.ts:tray.paused"]).toBe(
      "Pausiert bis zum Fortsetzen",
    );
    expect(DESKTOP_ENGLISH["apps/desktop/src/shared/i18n.ts:tray.open"]).toBe("Open SubKit");
    expect(Object.keys(DESKTOP_ENGLISH).length).toBe(Object.keys(DESKTOP_GERMAN).length);
  });

  test("German copy keeps the product terms Connector and Run in English", () => {
    expect(englishTermOffenders(ALL_GERMAN)).toEqual([]);
    expect(CATALOGS.de["cn.title"]).toBe(CATALOGS.de["nav.connectors"]);
    expect(CATALOGS.en["cn.title"]).toBe(CATALOGS.en["nav.connectors"]);
    expect(CATALOGS.de["nav.connectors"]).toBe("Connectors");
  });

  test("the term check lets everyday German through", () => {
    expect(
      englishTermOffenders({
        a: "Der Run läuft, im Laufe des Tages, laufend, abgelaufen, gelaufen, Laufwerk",
        b: "Verlauf, Ablauf, Abläufe, Laufzeit-Geheimnis, Beispielaufruf, Connector-Vorlage",
      }),
    ).toEqual([]);
    expect(
      englishTermOffenders({
        a: "Der Lauf",
        b: "Läufe",
        c: "Probelauf",
        d: "Konnektor",
        e: "Laufergebnis",
      }),
    ).toEqual(["a: Lauf", "b: Läufe", "c: Probelauf", "d: Konnektor", "e: Laufergebnis"]);
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

  test("a run starts by hand and a switched-off object is switched off", () => {
    expect(CATALOGS.de["workflows.trigger.request"]).toBe("Manuell");
    expect(CATALOGS.de["workflowStrip.state.unapproved"]).toBe("Braucht Freigabe");
    expect(CATALOGS.en["workflowStrip.state.unapproved"]).toBe("Needs approval");
    expect(CATALOGS.de["connectorState.off"]).toBe("Ausgeschaltet");
    expect(CATALOGS.de["workflowStrip.state.paused"]).toBe("Pausiert");
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
      ["Manuell", "Manual"],
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

describe("one word per stop", () => {
  const PERSON_PAUSED = [
    "automation.state.paused",
    "schedule.isPaused",
    "invocation.schedule.state.paused",
    "workflowStrip.state.paused",
    "notifications.paused",
    "tasks.filter.paused",
    "audit.reason.taskPaused",
  ] as const;
  const AUTO_PAUSED = [
    "overview.state.autoPaused",
    "overview.short.schedule_auto_paused",
    "overview.short.task_owner_unavailable",
    "overview.reason.schedule_auto_paused",
    "overview.reason.task_owner_unavailable",
    "notifications.event.schedule.auto_paused",
    "scheduleAutoPause.title",
    "tasks.strip.pausedOwner",
    "scheduleHistory.reason.repeated_failures",
  ] as const;
  const HELD = [
    "schedules.held.title",
    "schedules.held.since",
    "schedules.held.group",
    "scheduleHistory.state.held",
    "chat.schedule.pending",
    "pwa.notify.title.stopped",
    "operations.cause.held_for_review",
    "overview.reason.execution_authority_unavailable",
  ] as const;

  test("what a person paused is paused", () => {
    for (const key of PERSON_PAUSED) {
      expect(CATALOGS.de[key], key).toBe("Pausiert");
      expect(CATALOGS.en[key], key).toBe("Paused");
    }
  });

  test("what SubKit paused by itself says automatically", () => {
    for (const key of AUTO_PAUSED) {
      expect(CATALOGS.de[key].toLowerCase(), key).toContain("automatisch pausiert");
      expect(CATALOGS.en[key].toLowerCase(), key).toMatch(/paused automatically/);
    }
  });

  test("what waits for an approval is on hold, never paused, blocked or stopped", () => {
    for (const key of HELD) {
      expect(CATALOGS.de[key].toLowerCase(), key).toMatch(/angehalten/);
      expect(CATALOGS.en[key].toLowerCase(), key).toContain("on hold");
      expect(CATALOGS.de[key], key).not.toMatch(/pausiert|blockiert/i);
      expect(CATALOGS.en[key], key).not.toMatch(/paused|blocked|stopped/i);
    }
  });

  test("no state is called by another state's word", () => {
    const pausedAsHeld = Object.entries(CATALOGS.de).filter(
      ([key, value]) => /paused/i.test(key) && /angehalten/i.test(value),
    );
    expect(pausedAsHeld).toEqual([]);
    const heldAsPaused = Object.entries(CATALOGS.de).filter(
      ([key, value]) => /\.held\b|held_/i.test(key) && /pausiert|blockiert/i.test(value),
    );
    expect(heldAsPaused).toEqual([]);
  });
});
