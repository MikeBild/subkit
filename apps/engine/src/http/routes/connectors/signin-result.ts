import type { Context } from "hono";
import {
  cockpitConnectorUrl,
  type OAuthFlowOrigin,
  type SignInFailure,
  type SignInReturn,
} from "../../../connectors/index.ts";
import type { Db } from "../../../db/client.ts";
import { resolveSession, sessionIsLive } from "../oauth/shared.ts";
import {
  type AuthLocale,
  authHtmlResponse,
  COCKPIT_HOME,
  type PageLook,
  type ResultPage,
  renderResultPage,
  resolvePageLook,
} from "../oauth/ui.ts";

interface Copy {
  context: string;
  signedInTitle: string;
  signedIn: (name: string) => string;
  savedTitle: string;
  saved: (name: string) => string;
  receivedTitle: string;
  received: (name: string) => string;
  switchedOff: string;
  switchOnCommand: string;
  partial: (scopes: string) => string;
  next: Record<OAuthFlowOrigin, string | null>;
  restart: Record<OAuthFlowOrigin | "unknown", string>;
  failureTitle: Record<SignInFailure, string>;
  failure: Record<SignInFailure, string>;
  providerCode: (code: string) => string;
  field: (name: string) => string;
}

const COPY: Record<AuthLocale, Copy> = {
  en: {
    context: "Connector sign-in",
    signedInTitle: "Signed in",
    signedIn: (name) => `“${name}” is signed in.`,
    savedTitle: "Credential saved",
    saved: (name) => `The credentials for “${name}” are stored.`,
    receivedTitle: "Credential received",
    received: (name) => `The credentials for “${name}” are ready for the connection test.`,
    switchedOff: "The connector is switched off and stays off until someone switches it on.",
    switchOnCommand: "subkit connectors enable",
    partial: (scopes) =>
      `The provider did not grant every permission that was asked for. Missing: ${scopes}.`,
    next: {
      cli: "You can close this tab and return to the terminal.",
      chat: "You can close this tab and return to the conversation.",
      portal: "You can close this page.",
      cockpit: null,
    },
    restart: {
      cli: "Start the sign-in again from the terminal.",
      chat: "Ask for a fresh link in the conversation.",
      portal: "Ask for a fresh link where you got this one.",
      cockpit: "Start the sign-in again on the connector's page.",
      unknown: "Start the sign-in again where you began it.",
    },
    failureTitle: {
      link_expired: "Link expired",
      provider_declined: "Sign-in not completed",
      no_authorization: "Sign-in not completed",
      exchange_failed: "Sign-in failed",
      issuer_mismatch: "Sign-in rejected",
      connector_gone: "Connector not found",
      not_startable: "Sign-in could not be started",
      no_public_address: "Sign-in could not be started",
      unsupported_credential: "Credentials not accepted",
      missing_field: "Credentials not accepted",
      not_saved: "Credentials not saved",
    },
    failure: {
      link_expired: "This link has expired or was already used. Nothing was stored.",
      provider_declined: "The provider did not confirm the sign-in. Nothing was stored.",
      no_authorization:
        "The provider sent the browser back without an authorization. Nothing was stored.",
      exchange_failed:
        "The provider's answer could not be exchanged for access. Nothing was stored. The engine log has the details.",
      issuer_mismatch:
        "The answer came from a different authorization server than the one the sign-in started with. Nothing was stored.",
      connector_gone: "The connector this link belonged to no longer exists.",
      not_startable: "The sign-in could not be started, and this link is now used up.",
      no_public_address:
        "The engine has no public address. An administrator has to set server.public_base_url.",
      unsupported_credential: "This page cannot take the kind of credentials this connector uses.",
      missing_field:
        "A required field was empty. Nothing was stored, and this link is now used up.",
      not_saved: "The credentials could not be stored. This link is now used up.",
    },
    providerCode: (code) => `Provider code: ${code}`,
    field: (name) => `Missing: ${name}`,
  },
  de: {
    context: "Konnektor-Anmeldung",
    signedInTitle: "Angemeldet",
    signedIn: (name) => `„${name}“ ist angemeldet.`,
    savedTitle: "Zugangsdaten gespeichert",
    saved: (name) => `Die Zugangsdaten für „${name}“ sind hinterlegt.`,
    receivedTitle: "Zugangsdaten erhalten",
    received: (name) => `Die Zugangsdaten für „${name}“ liegen für den Verbindungstest bereit.`,
    switchedOff: "Der Konnektor ist abgeschaltet und bleibt es, bis ihn jemand einschaltet.",
    switchOnCommand: "subkit connectors enable",
    partial: (scopes) =>
      `Der Anbieter hat nicht alle angefragten Berechtigungen erteilt. Es fehlen: ${scopes}.`,
    next: {
      cli: "Du kannst diesen Tab schließen und zum Terminal zurückkehren.",
      chat: "Du kannst diesen Tab schließen und zur Unterhaltung zurückkehren.",
      portal: "Du kannst diese Seite schließen.",
      cockpit: null,
    },
    restart: {
      cli: "Starte die Anmeldung im Terminal neu.",
      chat: "Bitte in der Unterhaltung um einen neuen Link.",
      portal: "Bitte dort um einen neuen Link, wo du diesen bekommen hast.",
      cockpit: "Starte die Anmeldung auf der Seite des Konnektors neu.",
      unknown: "Starte die Anmeldung dort neu, wo du sie begonnen hast.",
    },
    failureTitle: {
      link_expired: "Link abgelaufen",
      provider_declined: "Anmeldung nicht abgeschlossen",
      no_authorization: "Anmeldung nicht abgeschlossen",
      exchange_failed: "Anmeldung fehlgeschlagen",
      issuer_mismatch: "Anmeldung abgelehnt",
      connector_gone: "Konnektor nicht gefunden",
      not_startable: "Anmeldung nicht gestartet",
      no_public_address: "Anmeldung nicht gestartet",
      unsupported_credential: "Zugangsdaten nicht angenommen",
      missing_field: "Zugangsdaten nicht angenommen",
      not_saved: "Zugangsdaten nicht gespeichert",
    },
    failure: {
      link_expired:
        "Dieser Link ist abgelaufen oder wurde schon verwendet. Es wurde nichts gespeichert.",
      provider_declined:
        "Der Anbieter hat die Anmeldung nicht bestätigt. Es wurde nichts gespeichert.",
      no_authorization:
        "Der Anbieter hat den Browser ohne Freigabe zurückgeschickt. Es wurde nichts gespeichert.",
      exchange_failed:
        "Die Antwort des Anbieters ließ sich nicht gegen einen Zugang tauschen. Es wurde nichts gespeichert. Einzelheiten stehen im Protokoll der Engine.",
      issuer_mismatch:
        "Die Antwort kam von einem anderen Autorisierungsserver als dem, bei dem die Anmeldung begann. Es wurde nichts gespeichert.",
      connector_gone: "Den Konnektor zu diesem Link gibt es nicht mehr.",
      not_startable: "Die Anmeldung ließ sich nicht starten, und dieser Link ist verbraucht.",
      no_public_address:
        "Die Engine hat keine öffentliche Adresse. Ein Administrator muss server.public_base_url setzen.",
      unsupported_credential:
        "Diese Seite kann die Art von Zugangsdaten, die dieser Konnektor nutzt, nicht annehmen.",
      missing_field:
        "Ein Pflichtfeld war leer. Es wurde nichts gespeichert, und dieser Link ist verbraucht.",
      not_saved: "Die Zugangsdaten ließen sich nicht speichern. Dieser Link ist verbraucht.",
    },
    providerCode: (code) => `Code des Anbieters: ${code}`,
    field: (name) => `Es fehlt: ${name}`,
  },
};

const RESTARTABLE: ReadonlySet<SignInFailure> = new Set([
  "link_expired",
  "provider_declined",
  "no_authorization",
  "exchange_failed",
  "issuer_mismatch",
  "not_startable",
  "missing_field",
  "not_saved",
]);

const PROVIDER_CODE = /^[a-z][a-z0-9_]{0,63}$/;

interface SignedInFacts {
  stored: "signed_in" | "credential_saved" | "credential_received";
  name: string;
  enabled: boolean;
  missing_scopes: readonly string[];
}

export function signedInPage(
  locale: AuthLocale,
  origin: OAuthFlowOrigin,
  facts: SignedInFacts,
  backlink: string | null,
): ResultPage {
  const copy = COPY[locale];
  const [title, statement] =
    facts.stored === "signed_in"
      ? [copy.signedInTitle, copy.signedIn(facts.name)]
      : facts.stored === "credential_saved"
        ? [copy.savedTitle, copy.saved(facts.name)]
        : [copy.receivedTitle, copy.received(facts.name)];
  const lines = [statement];
  if (facts.missing_scopes.length > 0) lines.push(copy.partial(facts.missing_scopes.join(", ")));
  if (!facts.enabled) lines.push(copy.switchedOff);
  const next = copy.next[origin];
  if (next) lines.push(next);
  return {
    kind: "success",
    title,
    lines,
    command: !facts.enabled && origin === "cli" ? copy.switchOnCommand : null,
    cockpitHref: backlink ?? COCKPIT_HOME,
    context: copy.context,
  };
}

export function signInFailedPage(
  locale: AuthLocale,
  origin: OAuthFlowOrigin | null,
  failure: SignInFailure,
  opts: { provider_code?: string | null; field?: string | null; backlink?: string | null } = {},
): ResultPage {
  const copy = COPY[locale];
  const lines = [copy.failure[failure]];
  if (opts.provider_code && PROVIDER_CODE.test(opts.provider_code))
    lines.push(copy.providerCode(opts.provider_code));
  if (opts.field) lines.push(copy.field(opts.field));
  if (RESTARTABLE.has(failure)) lines.push(copy.restart[origin ?? "unknown"]);
  return {
    kind: "error",
    title: copy.failureTitle[failure],
    lines,
    cockpitHref: opts.backlink ?? COCKPIT_HOME,
    context: copy.context,
  };
}

type RouteContext = Pick<Context, "req">;

export function requestLook(c: RouteContext): PageLook {
  return resolvePageLook(c.req.raw.headers);
}

export function requestLocale(c: RouteContext): AuthLocale {
  return requestLook(c).locale;
}

export function resultResponse(c: RouteContext, page: ResultPage): Response {
  return authHtmlResponse(
    renderResultPage(page, requestLook(c)),
    page.kind === "success" ? 200 : 400,
  );
}

export async function connectorBacklink(
  c: RouteContext,
  db: Db,
  flow: { origin: OAuthFlowOrigin; tenant_id: string; connector_id: string; redirect_uri: string },
): Promise<string | null> {
  const url = cockpitConnectorUrl({
    connector_id: flow.connector_id,
    redirect_uri: flow.redirect_uri,
  });
  if (!url) return null;
  if (flow.origin === "cockpit") return url;
  const session = await resolveSession(c.req.raw);
  if (!session || session.tenant_id !== flow.tenant_id) return null;
  return (await sessionIsLive(db, session.session_id, session.tenant_id)) ? url : null;
}

export function cockpitReturn(
  flow: { connector_id: string; redirect_uri: string },
  outcome: SignInReturn,
): Response | null {
  const location = cockpitConnectorUrl({ ...flow, outcome });
  if (!location) return null;
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
