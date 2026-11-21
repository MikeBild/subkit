export type BrowserActionClass = "read" | "prepare" | "commit";

export type BrowserActionKind =
  | "open"
  | "wait"
  | "extract"
  | "snapshot"
  | "screenshot"
  | "pdf"
  | "download"
  | "fill"
  | "select"
  | "check"
  | "key"
  | "click"
  | "submit";

export interface BrowserActionTarget {
  readonly action: BrowserActionKind;
  readonly page_url: string;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly input_type?: string | null;
  readonly href?: string | null;
  readonly download?: boolean;
  readonly expands?: boolean;
  readonly in_form?: boolean;
  readonly form_action?: string | null;
  readonly form_method?: string | null;
  readonly form_role?: string | null;
  readonly container?: string | null;
  readonly key?: string | null;
}

export interface CredentialFieldHint {
  readonly input_type?: string | null | undefined;
  readonly autocomplete?: string | null | undefined;
}

export const READ_ACTIONS: ReadonlySet<BrowserActionKind> = new Set<BrowserActionKind>([
  "open",
  "wait",
  "extract",
  "snapshot",
  "screenshot",
  "pdf",
]);

function words(terms: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${terms.join("|")})`, "u");
}

export const COMMIT_TERMS_LIST: readonly string[] = [
  "send",
  "submit",
  "place order",
  "order",
  "buy",
  "purchase",
  "pay",
  "checkout and pay",
  "book",
  "reserve",
  "confirm",
  "accept",
  "agree",
  "i agree",
  "delete",
  "remove",
  "erase",
  "destroy",
  "discard",
  "cancel (?:my |the |your )?(?:order|subscription|booking|reservation|membership|account|plan|contract|payment)",
  "unsubscribe",
  "upload",
  "save",
  "publish",
  "post",
  "sign up",
  "signup",
  "sign out",
  "log out",
  "logout",
  "transfer",
  "donate",
  "subscribe",
  "register",
  "reply",
  "forward",
  "share",
  "invite",
  "approve",
  "reject",
  "decline",
  "archive",
  "block",
  "report",
  "follow",
  "update",
  "change password",
  "reset",
  "senden",
  "absenden",
  "abschicken",
  "verschicken",
  "versenden",
  "einreichen",
  "bestell",
  "zahlungspflichtig",
  "kaufen",
  "jetzt kaufen",
  "bezahl",
  "zahlen",
  "buchen",
  "reservier",
  "bestätig",
  "akzeptier",
  "zustimm",
  "annehmen",
  "einverstanden",
  "lösch",
  "entfern",
  "verwerfen",
  "kündig",
  "stornier",
  "hochlad",
  "speicher",
  "veröffentlich",
  "posten",
  "unterschreib",
  "unterzeichn",
  "überweis",
  "spende",
  "abonnier",
  "registrier",
  "abmeld",
  "antwort",
  "weiterleit",
  "teilen",
  "einlad",
  "genehmig",
  "freigeb",
  "ablehn",
  "archivier",
  "blockier",
  "melden",
  "folgen",
  "aktualisier",
  "übernehmen",
  "zurücksetzen",
];
const COMMIT_TERMS = words(COMMIT_TERMS_LIST);

export const DESTRUCTIVE_TERMS_LIST: readonly string[] = [
  "delete",
  "remove",
  "pay",
  "buy",
  "order",
  "unsubscribe",
  "lösch",
  "entfern",
  "bezahl",
  "kaufen",
  "bestell",
  "kündig",
  "abmeld",
  "logout",
  "log out",
  "sign out",
];
const DESTRUCTIVE_TERMS = words(DESTRUCTIVE_TERMS_LIST);

export const CONSENT_TERMS_LIST: readonly string[] = [
  "cookie",
  "cookies",
  "consent",
  "einwillig",
  "tracking",
  "datenschutzeinstellung",
  "privatsphäre-einstellung",
  "privacy settings",
  "privacy preferences",
];
const CONSENT_TERMS = words(CONSENT_TERMS_LIST);

export const TERMS_TERMS_LIST: readonly string[] = [
  "terms",
  "conditions",
  "agb",
  "geschäftsbedingung",
  "nutzungsbedingung",
  "bedingungen",
  "vertrag",
  "contract",
  "widerruf",
];
const TERMS_TERMS = words(TERMS_TERMS_LIST);

export const SEARCH_NAMES_LIST: readonly string[] = [
  "search",
  "suche",
  "suchen",
  "find",
  "finden",
  "go",
  "los",
];
const SEARCH_NAMES = words(SEARCH_NAMES_LIST);

export const PREPARE_NAMES_LIST: readonly string[] = [
  "add to cart",
  "add to basket",
  "in den warenkorb",
  "zum warenkorb",
  "warenkorb",
  "merken",
  "wishlist",
  "merkliste",
  "compare",
  "vergleich",
  "filter",
  "sort",
  "sortier",
  "show",
  "anzeigen",
  "more",
  "mehr",
  "less",
  "weniger",
  "load more",
  "next",
  "weiter",
  "previous",
  "zurück",
  "back",
  "vorherige",
  "nächste",
  "close",
  "schließen",
  "dismiss",
  "cancel",
  "abbrechen",
  "open",
  "öffnen",
  "expand",
  "collapse",
  "ausklappen",
  "einklappen",
  "details",
  "menu",
  "menü",
  "zoom",
  "sign in",
  "log in",
  "login",
  "anmelden",
  "einloggen",
  "help",
  "hilfe",
  "copy",
  "kopieren",
  "select",
  "auswählen",
];
const PREPARE_NAMES = words(PREPARE_NAMES_LIST);

export const PREPARE_ROLES: ReadonlySet<string> = new Set([
  "tab",
  "option",
  "combobox",
  "treeitem",
  "radio",
  "checkbox",
  "searchbox",
  "textbox",
  "slider",
  "spinbutton",
  "listbox",
  "menuitemradio",
  "menuitemcheckbox",
  "scrollbar",
]);

export const COMMIT_PATH_SEGMENTS: readonly string[] = [
  "logout",
  "log-out",
  "signout",
  "sign-out",
  "delete",
  "remove",
  "unsubscribe",
  "cancel",
  "checkout",
  "pay",
  "payment",
  "order",
  "purchase",
  "confirm",
  "abmelden",
  "loeschen",
  "löschen",
  "kuendigen",
  "kündigen",
];

const COMMIT_PATH = new RegExp(
  `(?:^|[/_\\-.?=&])(?:${COMMIT_PATH_SEGMENTS.join("|")})(?:$|[/_\\-.?=&])`,
);

export const PREPARE_KEYS: ReadonlySet<string> = new Set([
  "tab",
  "shift+tab",
  "escape",
  "esc",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "space",
]);

function text(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isGetMethod(method: string | null | undefined): boolean {
  const value = text(method);
  return value === "" || value === "get";
}

function hasCommitPath(url: string): boolean {
  return COMMIT_PATH.test(url.toLowerCase());
}

function classifyLink(target: BrowserActionTarget, name: string): BrowserActionClass {
  const href = (target.href ?? "").trim();
  if (href === "" || /^javascript:/i.test(href)) return "commit";
  if (DESTRUCTIVE_TERMS.test(name) || hasCommitPath(href)) return "commit";
  if (!/^(https?:|\/|#|\.|\?)/i.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return "commit";
  return target.download ? "prepare" : "read";
}

function classifyFormSubmit(target: BrowserActionTarget): BrowserActionClass {
  if (!isGetMethod(target.form_method)) return "commit";
  const action = target.form_action;
  return typeof action === "string" && hasCommitPath(action) ? "commit" : "prepare";
}

function isSearchContext(target: BrowserActionTarget, role: string): boolean {
  return (
    text(target.form_role) === "search" ||
    text(target.input_type) === "search" ||
    role === "searchbox"
  );
}

function classifyCheck(
  target: BrowserActionTarget,
  name: string,
  role: string,
): BrowserActionClass {
  if (CONSENT_TERMS.test(`${name} ${text(target.container)}`)) return "prepare";
  if (TERMS_TERMS.test(name)) return "commit";
  return role === "switch" ? "commit" : "prepare";
}

function submitsForm(target: BrowserActionTarget, role: string): boolean {
  if (target.action === "submit") return true;
  return target.in_form === true && role === "button" && text(target.input_type) !== "button";
}

function classifyClick(
  target: BrowserActionTarget,
  name: string,
  role: string,
): BrowserActionClass {
  if (CONSENT_TERMS.test(`${name} ${text(target.container)}`) && !DESTRUCTIVE_TERMS.test(name)) {
    return "prepare";
  }
  if (isSearchContext(target, role) && isGetMethod(target.form_method)) return "prepare";
  if (COMMIT_TERMS.test(name)) return "commit";
  if (role === "link" || (target.href ?? "") !== "") return classifyLink(target, name);
  if (submitsForm(target, role)) return classifyFormSubmit(target);
  if (PREPARE_ROLES.has(role) || role === "menuitem") return "prepare";
  if (target.expands === true) return "prepare";
  return SEARCH_NAMES.test(name) || PREPARE_NAMES.test(name) ? "prepare" : "commit";
}

function classifyKey(target: BrowserActionTarget, name: string, role: string): BrowserActionClass {
  const key = text(target.key);
  if (key !== "enter" && key !== "return") return PREPARE_KEYS.has(key) ? "prepare" : "commit";
  if (target.in_form !== true) return "commit";
  if (isSearchContext(target, role) && isGetMethod(target.form_method)) return "prepare";
  if (COMMIT_TERMS.test(name)) return "commit";
  return classifyFormSubmit(target);
}

export function classifyBrowserAction(target: BrowserActionTarget): BrowserActionClass {
  if (READ_ACTIONS.has(target.action)) return "read";
  if (target.action === "download") return "prepare";
  if (target.action === "fill" || target.action === "select") return "prepare";
  const name = text(target.name);
  const role = text(target.role);
  if (target.action === "check") return classifyCheck(target, name, role);
  if (target.action === "key") return classifyKey(target, name, role);
  return classifyClick(target, name, role);
}

export const CREDENTIAL_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

export function isCredentialField(field: CredentialFieldHint): boolean {
  if (text(field.input_type) === "password") return true;
  return text(field.autocomplete)
    .split(" ")
    .some((token) => CREDENTIAL_AUTOCOMPLETE.has(token) || token.startsWith("cc-"));
}

export type AlwaysAskClass = "payment" | "deletion" | "sending" | "credential";

export const PAYMENT_TERMS_LIST: readonly string[] = [
  "pay",
  "buy",
  "purchase",
  "place order",
  "order now",
  "complete order",
  "donate",
  "transfer",
  "subscribe",
  "bezahl",
  "zahlen",
  "zahlungspflichtig",
  "kaufen",
  "jetzt kaufen",
  "bestellen",
  "jetzt bestellen",
  "bestellung absenden",
  "überweis",
  "spende",
  "abonnier",
];
const PAYMENT_TERMS = words(PAYMENT_TERMS_LIST);

export const DELETION_TERMS_LIST: readonly string[] = [
  "delete",
  "remove",
  "erase",
  "destroy",
  "discard",
  "empty trash",
  "lösch",
  "entfern",
  "verwerfen",
  "papierkorb leeren",
];
const DELETION_TERMS = words(DELETION_TERMS_LIST);

export const SENDING_TERMS_LIST: readonly string[] = [
  "send",
  "reply",
  "forward",
  "share",
  "invite",
  "post",
  "publish",
  "submit",
  "senden",
  "absenden",
  "abschicken",
  "verschicken",
  "versenden",
  "antwort",
  "weiterleit",
  "teilen",
  "einlad",
  "veröffentlich",
  "posten",
  "einreichen",
];
const SENDING_TERMS = words(SENDING_TERMS_LIST);

export function alwaysAskClassForName(name: string | null | undefined): AlwaysAskClass | null {
  const value = text(name);
  if (PAYMENT_TERMS.test(value)) return "payment";
  if (DELETION_TERMS.test(value)) return "deletion";
  if (SENDING_TERMS.test(value)) return "sending";
  return null;
}

export function alwaysAskClass(
  target: BrowserActionTarget,
  field: CredentialFieldHint = {},
): AlwaysAskClass | null {
  const typing = target.action === "fill" || target.action === "key" || target.action === "select";
  if (typing && isCredentialField({ input_type: target.input_type, ...field })) {
    return "credential";
  }
  if (classifyBrowserAction(target) !== "commit") return null;
  return alwaysAskClassForName(target.name);
}
