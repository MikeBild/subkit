import type { ClientErrorCause } from "./error-taxonomy.ts";

export const ERROR_CASES = [
  "unreachable",
  "signinCancelled",
  "session",
  "keyRejected",
  "tooBig",
  "duplicate",
  "feedbackFailed",
  "offline",
  "taskFailed",
  "reauth",
  "skillConflict",
  "pageFailed",
  "autoPaused",
  "privateSuggested",
  "fileDialog",
  "macPermission",
  "liveDeviceLost",
] as const;

export type ErrorCase = (typeof ERROR_CASES)[number];

export type ErrorLang = "de" | "en";

export interface ErrorText {
  title: string;
  body: string;
}

export interface ErrorCaseEntry {
  cause: ClientErrorCause;
  code: string;
  http: number | null;
  text: Readonly<Record<ErrorLang, ErrorText>>;
}

export const ERROR_CATALOG: Readonly<Record<ErrorCase, ErrorCaseEntry>> = {
  unreachable: {
    cause: "timeout",
    code: "timeout",
    http: null,
    text: {
      de: {
        title: "Server nicht erreichbar",
        body: "SubKit hat unter dieser Adresse keine Antwort bekommen. Geändert wurde nichts.",
      },
      en: {
        title: "Server not reachable",
        body: "SubKit got no response at this address. Nothing was changed.",
      },
    },
  },
  signinCancelled: {
    cause: "auth_failed",
    code: "auth_cancelled",
    http: null,
    text: {
      de: {
        title: "Anmeldung abgebrochen",
        body: "Im Browser wurde die Anmeldung nicht abgeschlossen. Du bist noch nicht angemeldet, geändert wurde nichts.",
      },
      en: {
        title: "Sign-in canceled",
        body: "The sign-in was not completed in the browser. You are not signed in yet; nothing was changed.",
      },
    },
  },
  session: {
    cause: "auth_failed",
    code: "auth_expired",
    http: 401,
    text: {
      de: {
        title: "Anmeldung abgelaufen",
        body: "Deine Sitzung ist abgelaufen. Laufende Freigaben bleiben bestehen, bis du dich neu anmeldest.",
      },
      en: {
        title: "Sign-in expired",
        body: "Your session has expired. Existing approvals stay in place until you sign in again.",
      },
    },
  },
  keyRejected: {
    cause: "auth_failed",
    code: "auth_failed",
    http: 401,
    text: {
      de: {
        title: "Anmeldung abgelehnt",
        body: "Der Anbieter hat diesen API-Schlüssel nicht angenommen. Der Arbeitsbereich wurde noch nicht angelegt.",
      },
      en: {
        title: "Sign-in rejected",
        body: "The provider did not accept this API key. The workspace has not been created yet.",
      },
    },
  },
  tooBig: {
    cause: "payload_invalid",
    code: "payload_too_large",
    http: 413,
    text: {
      de: {
        title: "Datei ist größer als 5 MB",
        body: "Diese Datei wurde nicht hochgeladen. Die anderen Dateien sind davon nicht betroffen.",
      },
      en: {
        title: "File is larger than 5 MB",
        body: "This file was not uploaded. The other files are not affected.",
      },
    },
  },
  duplicate: {
    cause: "payload_invalid",
    code: "duplicate_content",
    http: 409,
    text: {
      de: {
        title: "Datei gibt es schon",
        body: "Eine andere Datei hat genau diesen Inhalt. Diese wurde nicht noch einmal angelegt.",
      },
      en: {
        title: "File already exists",
        body: "Another file has exactly this content. It was not added again.",
      },
    },
  },
  feedbackFailed: {
    cause: "timeout",
    code: "timeout",
    http: 504,
    text: {
      de: {
        title: "Feedback nicht gesendet",
        body: "Dein Entwurf ist gespeichert und wurde nicht verworfen. Du kannst es gleich noch einmal versuchen.",
      },
      en: {
        title: "Feedback not sent",
        body: "Your draft is saved and was not discarded. You can try again right away.",
      },
    },
  },
  offline: {
    cause: "timeout",
    code: "server_offline",
    http: 503,
    text: {
      de: {
        title: "Server offline",
        body: "SubKit kann gerade nichts ausführen. Neue Nachrichten warten in der Warteschlange, geändert wurde nichts.",
      },
      en: {
        title: "Server offline",
        body: "SubKit can’t run anything right now. New messages wait in the queue; nothing was changed.",
      },
    },
  },
  taskFailed: {
    cause: "timeout",
    code: "timeout",
    http: 504,
    text: {
      de: {
        title: "Aufgabe fehlgeschlagen",
        body: "Der Run ist an einem Schritt hängen geblieben. Vor deiner Freigabe wurde nichts geändert.",
      },
      en: {
        title: "Task failed",
        body: "The run got stuck on a step. Nothing was changed without your approval.",
      },
    },
  },
  reauth: {
    cause: "auth_failed",
    code: "auth_failed",
    http: 401,
    text: {
      de: {
        title: "Anmeldung abgelaufen",
        body: "Workflows, die diesen Connector nutzen, pausieren. Geändert wurde nichts.",
      },
      en: {
        title: "Sign-in expired",
        body: "Workflows using this connector are paused. Nothing was changed.",
      },
    },
  },
  skillConflict: {
    cause: "authority_mismatch",
    code: "version_conflict",
    http: 409,
    text: {
      de: {
        title: "Freigabe passt nicht mehr",
        body: "Jemand hat den Skill inzwischen geändert. Deine Version wurde nicht gespeichert.",
      },
      en: {
        title: "Approval no longer matches",
        body: "Someone changed the skill in the meantime. Your version was not saved.",
      },
    },
  },
  pageFailed: {
    cause: "unknown",
    code: "load_failed",
    http: 500,
    text: {
      de: {
        title: "Diese Seite ließ sich nicht anzeigen",
        body: "Die Daten für diese Ansicht kamen nicht an. Geändert wurde nichts.",
      },
      en: {
        title: "This page couldn’t be shown",
        body: "The data for this view didn’t arrive. Nothing was changed.",
      },
    },
  },
  autoPaused: {
    cause: "authority_mismatch",
    code: "approval_mismatch",
    http: 403,
    text: {
      de: {
        title: "Automatisch pausiert",
        body: "5 Runs in Folge sind an derselben Ursache gescheitert. Geändert wurde nichts.",
      },
      en: {
        title: "Paused automatically",
        body: "5 runs in a row failed for the same cause. Nothing was changed.",
      },
    },
  },
  privateSuggested: {
    cause: "authority_mismatch",
    code: "private_address",
    http: null,
    text: {
      de: {
        title: "Private Adresse abgelehnt",
        body: "Nur du darfst private Adressen eingeben. Die Seite hat nichts geöffnet. Nichts wurde geändert.",
      },
      en: {
        title: "Private address refused",
        body: "Only you may enter private addresses. The page opened nothing. Nothing was changed.",
      },
    },
  },
  fileDialog: {
    cause: "authority_mismatch",
    code: "blocked_app",
    http: null,
    text: {
      de: {
        title: "Datei-Dialog nicht bedient",
        body: "Datei-Dialoge bedienst du selbst; für Dateien nutzt SubKit die freigegebenen Ordner. Es wurde nichts gesendet.",
      },
      en: {
        title: "File dialog left to you",
        body: "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
      },
    },
  },
  macPermission: {
    cause: "auth_failed",
    code: "permission_missing",
    http: null,
    text: {
      de: {
        title: "Berechtigung fehlt: Bedienungshilfen",
        body: "SubKit kann Apps nicht bedienen. Deine erlaubten Apps wurden nicht geändert. Richte die Berechtigung erneut ein.",
      },
      en: {
        title: "Permission missing: Accessibility",
        body: "SubKit cannot use apps. Your allowed apps were not changed. Set up the permission again.",
      },
    },
  },
  liveDeviceLost: {
    cause: "timeout",
    code: "device_connection_lost",
    http: null,
    text: {
      de: {
        title: "Verbindung zum Mac verloren",
        body: "SubKit führt keine weiteren Schritte aus. Bereits erledigte Schritte bleiben, spätere wurden nicht geändert. Verbinde das Gerät erneut.",
      },
      en: {
        title: "Connection to the Mac lost",
        body: "SubKit will not perform further steps. Completed steps remain; later steps were not changed. Reconnect the device.",
      },
    },
  },
};

export const ERROR_CAUSE_LABELS: Readonly<
  Record<ErrorLang, Readonly<Record<ClientErrorCause, string>>>
> = {
  de: {
    auth_failed: "Anmeldung abgelehnt",
    placeholder_unresolved: "Platzhalter nicht aufgelöst",
    schema_mismatch: "Antwort in unerwarteter Form",
    timeout: "Zeitüberschreitung",
    aborted: "Abgebrochen",
    connector_missing: "Connector fehlt",
    budget_exhausted: "Budget erschöpft",
    connector_unavailable: "Connector nicht verfügbar",
    refused_before_start: "Vor dem Start abgelehnt",
    authority_mismatch: "Freigabe passt nicht mehr",
    payload_invalid: "Daten nicht angenommen",
    driver_error: "Fehler im Fremdsystem",
    preview_unsupported: "Vorschau nicht möglich",
    unknown: "Nicht eingeordnet",
    incomplete_read: "Nicht vollständig gelesen",
    rate_limited: "Abrufgrenze des Anbieters erreicht",
    step_error: "Fehler im Code des Schritts",
    version_unsupported: "Version nicht unterstützt",
  },
  en: {
    auth_failed: "Sign-in rejected",
    placeholder_unresolved: "Placeholder not resolved",
    schema_mismatch: "Unexpected response shape",
    timeout: "Timed out",
    aborted: "Canceled",
    connector_missing: "Connector missing",
    budget_exhausted: "Budget used up",
    connector_unavailable: "Connector unavailable",
    refused_before_start: "Refused before start",
    authority_mismatch: "Approval no longer matches",
    payload_invalid: "Data not accepted",
    driver_error: "Error in external system",
    preview_unsupported: "Preview not supported",
    unknown: "Not classified",
    incomplete_read: "Not read completely",
    rate_limited: "Provider rate limit reached",
    step_error: "Error in the step's code",
    version_unsupported: "Version not supported",
  },
};

export interface ErrorCatalogView {
  cases: Readonly<
    Record<string, { meta: { cause: string; code: string; http: number | null }; copy: ErrorText }>
  >;
  causes: Readonly<Record<string, string>>;
}

function catalogView(lang: ErrorLang): ErrorCatalogView {
  const cases = Object.fromEntries(
    ERROR_CASES.map((kind) => {
      const entry = ERROR_CATALOG[kind];
      return [
        kind,
        {
          meta: { cause: entry.cause, code: entry.code, http: entry.http },
          copy: entry.text[lang],
        },
      ];
    }),
  );
  return { cases, causes: ERROR_CAUSE_LABELS[lang] };
}

const VIEWS: Readonly<Record<ErrorLang, ErrorCatalogView>> = {
  de: catalogView("de"),
  en: catalogView("en"),
};

export function errorCatalog(lang: ErrorLang): ErrorCatalogView {
  return VIEWS[lang];
}
