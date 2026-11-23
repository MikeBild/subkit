import type { AuthLocale } from "../routes/oauth/ui.ts";

export type RefusalKind = "rate_limited" | "target_refused" | "cross_site" | "other";

export const REFUSAL_COPY: Record<
  AuthLocale,
  Record<RefusalKind, { title: string; line: (retryAfter: number | null) => string }> & {
    reload: string;
    code: string;
    context: string;
  }
> = {
  en: {
    rate_limited: {
      title: "Too many attempts",
      line: (seconds) =>
        seconds
          ? `Wait ${seconds} seconds, then reload the page.`
          : "Wait a moment, then reload the page.",
    },
    target_refused: {
      title: "This sign-in target is not accepted",
      line: () =>
        "The link leads to a target this server does not know. Start the sign-in again where you began it.",
    },
    cross_site: {
      title: "Request refused",
      line: () =>
        "The request came from another website. Open the link again from where you got it. Nothing was changed.",
    },
    other: {
      title: "This page could not be opened",
      line: () => "SubKit could not handle the request. Start again where you began.",
    },
    reload: "Reload",
    code: "Code",
    context: "Engine",
  },
  de: {
    rate_limited: {
      title: "Zu viele Versuche",
      line: (seconds) =>
        seconds
          ? `Warte ${seconds} Sekunden und lade die Seite dann neu.`
          : "Warte einen Moment und lade die Seite dann neu.",
    },
    target_refused: {
      title: "Dieses Anmeldeziel wird nicht angenommen",
      line: () =>
        "Der Link führt zu einem Ziel, das dieser Server nicht kennt. Starte die Anmeldung dort neu, wo du sie begonnen hast.",
    },
    cross_site: {
      title: "Anfrage abgelehnt",
      line: () =>
        "Die Anfrage kam von einer anderen Website. Öffne den Link erneut dort, wo du ihn bekommen hast. Geändert wurde nichts.",
    },
    other: {
      title: "Diese Seite ließ sich nicht öffnen",
      line: () =>
        "SubKit konnte die Anfrage nicht bearbeiten. Starte den Vorgang dort neu, wo du ihn begonnen hast.",
    },
    reload: "Neu laden",
    code: "Code",
    context: "Engine",
  },
};
