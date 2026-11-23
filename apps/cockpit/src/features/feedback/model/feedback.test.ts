import { describe, expect, test } from "bun:test";
import {
  appendClientError,
  attachmentProblem,
  base64OfDataUrl,
  buildFeedbackBody,
  buildFeedbackDiagnostics,
  clientErrorCode,
  clientKindOf,
  desktopFacts,
  diagnosticsAttachment,
  FEEDBACK_DIAGNOSTICS_FILENAME,
  FEEDBACK_DRAFT_KEY,
  feedbackFailure,
  feedbackResponse,
  hasFeedbackDraft,
  latestTraceId,
  mergePrefill,
  newFeedbackDraft,
  readStoredDraft,
  routeOf,
  screenshotHint,
  writeStoredDraft,
} from "@/features/feedback/model/feedback";
import { CATALOGS, translate } from "@/lib/i18n";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("feedback draft", () => {
  test("a new draft is a bug report with diagnostics on and the window picture off", () => {
    expect(newFeedbackDraft()).toEqual({
      kind: "bug",
      text: "",
      files: [],
      screenshot: null,
      screenshotIncluded: false,
      diagnostics: true,
    });
    expect(hasFeedbackDraft(newFeedbackDraft())).toBe(false);
  });

  test("every deviation from the defaults counts as a draft", () => {
    const base = newFeedbackDraft();
    expect(hasFeedbackDraft({ ...base, text: "  " })).toBe(false);
    expect(hasFeedbackDraft({ ...base, text: "x" })).toBe(true);
    expect(hasFeedbackDraft({ ...base, kind: "idea" })).toBe(true);
    expect(hasFeedbackDraft({ ...base, diagnostics: false })).toBe(true);
    expect(hasFeedbackDraft({ ...base, screenshotIncluded: true })).toBe(true);
    expect(
      hasFeedbackDraft({
        ...base,
        files: [{ id: "1", name: "a.txt", size: 1, content_base64: "" }],
      }),
    ).toBe(true);
  });

  test("the draft survives in storage without file contents", () => {
    const storage = memoryStorage();
    writeStoredDraft(storage, {
      ...newFeedbackDraft(),
      kind: "idea",
      text: "More colors",
      diagnostics: false,
      screenshot: "AAAA",
      files: [{ id: "1", name: "a.txt", size: 1, content_base64: "QQ==" }],
    });
    expect(storage.values.get(FEEDBACK_DRAFT_KEY)).not.toContain("QQ==");
    expect(storage.values.get(FEEDBACK_DRAFT_KEY)).not.toContain("AAAA");
    expect(readStoredDraft(storage)).toEqual({
      ...newFeedbackDraft(),
      kind: "idea",
      text: "More colors",
      diagnostics: false,
    });
  });

  test("an empty draft clears the storage and broken storage yields a new draft", () => {
    const storage = memoryStorage({ [FEEDBACK_DRAFT_KEY]: "{broken" });
    expect(readStoredDraft(storage)).toEqual(newFeedbackDraft());
    writeStoredDraft(storage, newFeedbackDraft());
    expect(storage.values.has(FEEDBACK_DRAFT_KEY)).toBe(false);
    expect(readStoredDraft(null)).toEqual(newFeedbackDraft());
    expect(
      readStoredDraft(memoryStorage({ [FEEDBACK_DRAFT_KEY]: '{"kind":"x","text":7}' })),
    ).toEqual(newFeedbackDraft());
  });
});

describe("attachments", () => {
  test("allows three files of the five kinds up to 2 MB", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.pdf", "a.txt", "a.json"])
      expect(attachmentProblem(0, { name, size: 2 * 1024 * 1024 })).toBeNull();
    expect(attachmentProblem(3, { name: "a.png", size: 1 })).toBe("limit");
    expect(attachmentProblem(0, { name: "a.png", size: 2 * 1024 * 1024 + 1 })).toBe("size");
    expect(attachmentProblem(0, { name: "a.svg", size: 1 })).toBe("type");
  });

  test("the error texts name the limits in both languages", () => {
    expect(CATALOGS.de["feedback.problem.limit"]).toBe("Höchstens 3 Dateien.");
    expect(CATALOGS.de["feedback.problem.size"]).toBe("Höchstens 2 MB pro Datei.");
    expect(CATALOGS.de["feedback.problem.type"]).toBe("Erlaubt sind PNG, JPG, PDF, TXT und JSON.");
    expect(CATALOGS.en["feedback.problem.type"]).toBe("PNG, JPG, PDF, TXT, and JSON are allowed.");
  });

  test("takes the base64 part of a data address", () => {
    expect(base64OfDataUrl("data:text/plain;base64,aGk=")).toBe("aGk=");
    expect(base64OfDataUrl("nothing")).toBe("");
  });
});

describe("diagnostics", () => {
  test("names the client kind", () => {
    expect(clientKindOf({ desktop: true, standalone: true })).toBe("desktop");
    expect(clientKindOf({ desktop: false, standalone: true })).toBe("pwa");
    expect(clientKindOf({ desktop: false, standalone: false })).toBe("browser");
  });

  test("keeps the route without query string", () => {
    expect(routeOf("/workflows/abc?tab=runs#top")).toBe("/workflows/abc");
    expect(routeOf("/intake")).toBe("/intake");
  });

  test("reads the desktop bundle defensively", () => {
    expect(
      desktopFacts({
        app: { version: "0.1.0" },
        os: { platform: "darwin", release: "25.0", arch: "arm64" },
        errors: [
          { at: "2026-11-20T10:00:00.000Z", scope: "cockpit.load", message: "-105 failed" },
          { at: "never", scope: "x", message: "y" },
          "nonsense",
        ],
      }),
    ).toEqual({
      appVersion: "0.1.0",
      platform: "darwin 25.0 arm64",
      errors: [{ code: "cockpit.load: -105 failed", at: "2026-11-20T10:00:00.000Z" }],
    });
    expect(desktopFacts(null)).toEqual({ appVersion: null, platform: null, errors: [] });
  });

  test("builds the report with the last ten errors in order", () => {
    const errors = Array.from({ length: 12 }, (_, index) => ({
      code: `e${index} /Users/alex/x`,
      at: new Date(Date.UTC(2026, 10, 20, 10, 12 - index)).toISOString(),
    }));
    const diagnostics = buildFeedbackDiagnostics({
      clientKind: "browser",
      appVersion: "11.1.0",
      platform: null,
      serverVersion: "11.1.0",
      connection: "live",
      route: "/files?download=1",
      errors,
      removed: "[removed]",
    });
    expect(diagnostics.client_kind).toBe("browser");
    expect(diagnostics.platform).toBeUndefined();
    expect(diagnostics.route).toBe("/files");
    expect(diagnostics.recent_errors).toHaveLength(10);
    expect(diagnostics.recent_errors?.[0]?.code).toBe("e9 [removed]");
    expect(diagnostics.recent_errors?.[9]?.code).toBe("e0 [removed]");
  });

  test("names a failed request by code and status and other errors by their kind", () => {
    expect(clientErrorCode({ status: 500, code: "internal_error", message: "secret text" })).toBe(
      "internal_error (500)",
    );
    expect(clientErrorCode({ status: 502 })).toBe("request_failed (502)");
    expect(
      clientErrorCode({
        status: 503,
        code: "unavailable",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      }),
    ).toBe("unavailable (503) trace=4bf92f3577b34da6a3ce929d0e0e4736");
    expect(clientErrorCode({ status: 503, traceId: "not a trace <script>" })).toBe(
      "request_failed (503)",
    );
    expect(clientErrorCode(new TypeError("private detail"))).toBe("TypeError");
    expect(clientErrorCode("text")).toBe("Error");
  });

  test("keeps ten errors and drops an immediate repeat", () => {
    let log = appendClientError([], { code: "a", at: "2026-11-20T10:00:00.000Z" });
    log = appendClientError(log, { code: "a", at: "2026-11-20T10:00:00.500Z" });
    expect(log).toHaveLength(1);
    for (let index = 0; index < 12; index++)
      log = appendClientError(log, { code: `b${index}`, at: "2026-11-20T10:01:00.000Z" });
    expect(log).toHaveLength(10);
    expect(log[9]?.code).toBe("b11");
  });
});

describe("prefill from an error notice", () => {
  test("adds the prefill to an existing draft once", () => {
    expect(mergePrefill("", "Fehler: X")).toBe("Fehler: X");
    expect(mergePrefill("My note", "Fehler: X")).toBe("My note\n\nFehler: X");
    expect(mergePrefill("My note\n\nFehler: X", "Fehler: X")).toBe("My note\n\nFehler: X");
  });
});

describe("window picture", () => {
  test("is never sent unless it was ticked, and the tick is not remembered", () => {
    const draft = { ...newFeedbackDraft(), text: "x", screenshot: "AAAA" };
    expect(
      buildFeedbackBody({ requestId: "r", draft, diagnostics: null }).screenshot_png_base64,
    ).toBeUndefined();
    const storage = memoryStorage();
    writeStoredDraft(storage, { ...draft, screenshotIncluded: true });
    expect(readStoredDraft(storage).screenshotIncluded).toBe(false);
    writeStoredDraft(storage, { ...newFeedbackDraft(), screenshotIncluded: true });
    expect(storage.values.has(FEEDBACK_DRAFT_KEY)).toBe(false);
  });

  test("the hint follows what the shell says it can hide", () => {
    expect(screenshotHint(null)).toBe("none");
    expect(screenshotHint({ masksSecretFields: false, masksVisibleText: false })).toBe("none");
    expect(screenshotHint({ masksSecretFields: true, masksVisibleText: false })).toBe("fields");
    expect(screenshotHint({ masksSecretFields: true, masksVisibleText: true })).toBe("masked");
    for (const hint of ["masked", "fields", "none"] as const) {
      expect(CATALOGS.de[`feedback.screenshot.hint.${hint}`].length).toBeGreaterThan(10);
      expect(CATALOGS.en[`feedback.screenshot.hint.${hint}`].length).toBeGreaterThan(10);
    }
  });
});

describe("request body", () => {
  test("sends only what the draft includes", () => {
    const draft = {
      ...newFeedbackDraft(),
      text: "  Save does nothing  ",
      screenshot: "AAAA",
      screenshotIncluded: true,
      files: [{ id: "1", name: "a.txt", size: 1, content_base64: "QQ==" }],
    };
    const diagnostics = { client_kind: "browser" as const };
    expect(buildFeedbackBody({ requestId: "r", draft, diagnostics })).toEqual({
      client_request_id: "r",
      kind: "bug",
      message: "Save does nothing",
      diagnostics,
      attachments: [{ filename: "a.txt", content_base64: "QQ==" }],
      screenshot_png_base64: "AAAA",
    });
    expect(
      buildFeedbackBody({
        requestId: "r",
        draft: { ...draft, diagnostics: false, screenshotIncluded: false, files: [] },
        diagnostics,
      }),
    ).toEqual({ client_request_id: "r", kind: "bug", message: "Save does nothing" });
  });

  test("classifies a failed send", () => {
    expect(feedbackFailure({ status: 429 })).toBe("rateLimited");
    expect(feedbackFailure({ status: 413 })).toBe("attachment");
    expect(feedbackFailure({ status: 422 })).toBe("attachment");
    expect(feedbackFailure(new Error("offline"))).toBe("generic");
  });
});

describe("feedback copy", () => {
  test("uses the agreed German and English texts", () => {
    expect(CATALOGS.de["feedback.entry"]).toBe("Fehler melden");
    expect(CATALOGS.en["feedback.entry"]).toBe("Report a bug");
    expect(CATALOGS.de["feedback.send"]).toBe("Feedback senden");
    expect(CATALOGS.de["feedback.discard"]).toBe("Entwurf verwerfen");
    expect(CATALOGS.de["feedback.thanks"]).toBe("Danke, dein Bericht ist angekommen");
    expect(CATALOGS.de["feedback.reference"]).toBe("Meldungs-ID: {id}");
    expect(CATALOGS.en["feedback.thanks"]).toBe("Thanks, your report has arrived");
    expect(CATALOGS.en["feedback.reference"]).toBe("Report ID: {id}");
    expect(CATALOGS.de["feedback.screenshot"]).toBe("Bildschirmfoto des Fensters");
    expect(CATALOGS.de["feedback.diagnostics"]).toBe("Diagnosebericht anhängen");
    expect(CATALOGS.de["feedback.redact"]).toBe(
      "Geheimnisse, Adressen und Pfade werden vor dem Senden entfernt.",
    );
    expect(CATALOGS.de["feedback.notice"]).toEndWith("Prüfe Text und Dateien auf private Angaben.");
    expect(CATALOGS.en["feedback.thanks"]).not.toContain("!");
  });
});

describe("what the dialog says before sending", () => {
  test("the notice names the workspace inbox, its readers and what happens to the text", () => {
    const de = translate("de", "feedback.notice");
    expect(de).toContain("Eingang deines Arbeitsbereichs");
    expect(de).toContain("Administratoren und Mitglieder");
    expect(de).not.toContain("Dort sehen ihn alle");
    expect(de).toContain("auch E-Mail-Adressen");
    expect(de).not.toContain("Eingang deines Administrators");
    const en = translate("en", "feedback.notice");
    expect(en).toContain("Inbox of your workspace");
    expect(en).toContain("administrators and members");
    expect(en).not.toContain("administrator’s inbox");
  });

  test("the attachment control says that images and PDFs cannot be cleaned", () => {
    expect(translate("de", "feedback.attachUncleaned")).toContain(
      "Bilder und PDFs werden unverändert",
    );
    expect(translate("en", "feedback.attachUncleaned")).toContain(
      "Images and PDFs are sent as they are",
    );
  });
});

describe("reports written offline", () => {
  test("the body carries the request id and the time it was written on the device", () => {
    const body = buildFeedbackBody({
      requestId: "r-1",
      draft: { ...newFeedbackDraft(), text: "Hallo" },
      diagnostics: null,
      createdAt: "2026-11-21T10:00:00.000Z",
    });
    expect(body.client_request_id).toBe("r-1");
    expect(body.created_on_device_at).toBe("2026-11-21T10:00:00.000Z");
  });

  test("a failed send maps to the status the queue classifies, a network error to none", () => {
    expect(feedbackResponse(new TypeError("Failed to fetch"))).toBeNull();
    expect(feedbackResponse({ status: 503 })).toEqual({ status: 503 });
    expect(feedbackResponse({ status: 429, details: { retry_after_seconds: 90 } })).toEqual({
      status: 429,
      retry_after_seconds: 90,
    });
  });
});

describe("diagnostics attachment", () => {
  const diagnostics = {
    client_kind: "desktop" as const,
    connection: "live",
    recent_errors: [
      { code: "events.stream: Error: event stream answered 409", at: "2026-11-23T07:17:01.000Z" },
      {
        code: "events.stream: Error: event stream answered 409 code=tenant_context_changed trace=4bf92f3577b34da6a3ce929d0e0e4736",
        at: "2026-11-23T07:17:05.000Z",
      },
    ],
  };

  test("the report names the trace id of the latest failing request", () => {
    expect(latestTraceId(null, diagnostics.recent_errors)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(latestTraceId("abcdef0123456789", diagnostics.recent_errors)).toBe("abcdef0123456789");
    expect(latestTraceId(null, [])).toBeNull();
  });

  test("the cleaned diagnostics travel as a JSON file next to the summary", () => {
    const file = diagnosticsAttachment(diagnostics, {
      traceId: null,
      connectionCause: "request_ok",
    });
    expect(file.filename).toBe(FEEDBACK_DIAGNOSTICS_FILENAME);
    const content = JSON.parse(Buffer.from(file.content_base64, "base64").toString("utf8"));
    expect(content).toMatchObject({
      client_kind: "desktop",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      connection_cause: "request_ok",
    });
    const draft = { ...newFeedbackDraft(), text: "Server offline" };
    expect(
      buildFeedbackBody({ requestId: "r", draft, diagnostics, diagnosticsFile: file }).attachments,
    ).toEqual([file]);
    expect(
      buildFeedbackBody({
        requestId: "r",
        draft: { ...draft, diagnostics: false },
        diagnostics,
        diagnosticsFile: file,
      }).attachments,
    ).toBeUndefined();
  });
});
