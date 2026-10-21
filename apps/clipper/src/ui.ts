import { apiUrl } from "./clipper.ts";
import type { CaptureDiagnostic } from "./types.ts";

export interface Copy {
  title: string;
  heading: string;
  setup: string;
  category: string;
  newCategory: string;
  categoryName: string;
  save: string;
  retry: string;
  settings: string;
  saved: string;
  duplicate: string;
  replace: string;
  copy: string;
  content: string;
  titleField: string;
  sourceField: string;
  error: string;
  connection: string;
  engine: string;
  key: string;
  saveConnection: string;
  clearKey: string;
  author: string;
  publishedAt: string;
  discard: string;
  newCapture: string;
  captureFailed: string;
  draftOtherEngine: string;
  needsSettings: string;
  categoryRequired: string;
  needsClipApi: string;
  intakeUnavailable: string;
  invalidApiKey: string;
  missingIntakeReadPermission: string;
  missingIntakeWritePermission: string;
  connectionFailed: string;
  apiResponseFailed: string;
  collectionRejected: string;
  connectionRetrySucceeded: string;
  checkingConnection: string;
  connectionVerified: string;
  connectionReadOnlyVerified: string;
  categoryUnavailable: string;
  categoriesUnavailable: string;
  categoriesLoading: string;
  destinationUnavailable: string;
  checkConnection: string;
  emptyPreview: string;
  attemptUncertain: string;
  permissionDenied: string;
  invalidEngine: string;
  keyRequired: string;
  savedConnection: string;
  keyCleared: string;
  retryAttempt: string;
  previousSaved: string;
  capturedFrom: string;
  drafts: string;
  currentPage: string;
  otherDraft: string;
  contentPreview: string;
  contentSize: string;
  description: string;
  transcript: string;
  transcriptUnavailable: string;
  contentChanged: string;
  mainContentUnavailable: string;
  metadataUnavailable: string;
  articleFallback: string;
  selectionEmpty: string;
  words: string;
  characters: string;
  reopenCapture: string;
  note: string;
  details: string;
  review: string;
  reviewPrompt: string;
  reviewItemPrompt: string;
  journey: string;
  notKnowledge: string;
  savedForReview: string;
  retryPending: string;
  help: string;
  helpLabel: string;
  intro: string;
  languageField: string;
  settingsTitle: string;
}

export const copy: Record<"de" | "en", Copy> = {
  de: {
    title: "In SubKit sammeln",
    note: "Warum ist das interessant? (optional)",
    details: "Details und Inhalt bearbeiten",
    review: "Im Chat prüfen",
    reviewPrompt:
      "Schau meine neuen {collection}-Einträge durch. Welche davon helfen uns? Schlage mit Quellenbezug vor, was wir übernehmen sollten, als Wissen oder als Skill.",
    reviewItemPrompt:
      "Prüfe diesen gesammelten Eintrag. Bewerte seinen Nutzen und bereite einen Vorschlag mit Quelle und Ziel zur Bestätigung vor, als Wissen oder als Skill.",
    journey: "Sammeln → im Chat prüfen → Übernahme bestätigen → Wissen oder Skill",
    notKnowledge: "Noch nicht als Wissen oder Skill übernommen.",
    savedForReview: "Gesammelt für die Prüfung",
    retryPending:
      "Die Speicherung ist noch nicht bestätigt. Versuche es erneut; dein Entwurf bleibt erhalten.",
    heading: "Für später sammeln",
    setup: "Verbindung einrichten",
    category: "Kategorie",
    newCategory: "Neue Kategorie",
    categoryName: "Neue Kategorie",
    save: "Sammeln",
    retry: "Erneut versuchen",
    settings: "Einstellungen",
    saved: "Gesammelt",
    duplicate: "Dieser Clip existiert bereits.",
    replace: "Ersetzen",
    copy: "Als Kopie sichern",
    content: "Markdown",
    titleField: "Titel",
    sourceField: "Quelladresse",
    error: "Der Entwurf bleibt lokal erhalten.",
    connection: "Verbindung",
    engine: "Engine-Adresse",
    key: "API-Schlüssel",
    saveConnection: "Verbindung speichern",
    clearKey: "API-Schlüssel löschen",
    author: "Autor der Quelle",
    publishedAt: "Veröffentlicht am",
    discard: "Entwurf verwerfen",
    newCapture: "Neu erfassen",
    captureFailed: "Die Seite konnte nicht erfasst werden.",
    draftOtherEngine: "Dieser Entwurf gehört zu einer anderen Engine.",
    needsSettings: "Lege zuerst eine Engine-Adresse und einen API-Schlüssel fest.",
    categoryRequired: "Gib eine gültige Kategorie ein.",
    needsClipApi: "Sammeln ist hier noch nicht verfügbar.",
    intakeUnavailable: "Sammeln ist gerade nicht verfügbar. Dein Entwurf bleibt gespeichert.",
    invalidApiKey:
      "Der API-Schlüssel ist ungültig oder abgelaufen. Lege unter „API-Zugang“ im Cockpit einen Schlüssel mit der Vorlage „Web Clipper“ an. Speichere ihn über das Zahnrad in den Verbindungseinstellungen.",
    missingIntakeReadPermission:
      "Dem API-Schlüssel fehlt intake:read. Lege unter „API-Zugang“ im Cockpit einen Schlüssel mit der Vorlage „Web Clipper“ an. Speichere ihn über das Zahnrad in den Verbindungseinstellungen.",
    missingIntakeWritePermission:
      "Die Verbindung steht, aber dem API-Schlüssel fehlt intake:write. Lege unter „API-Zugang“ im Cockpit einen Schlüssel mit der Vorlage „Web Clipper“ an und speichere ihn hier. Dein Entwurf bleibt erhalten.",
    connectionFailed:
      "Die SubKit-API ist nicht erreichbar. Prüfe Engine-Adresse, Internetverbindung und den Chrome-Zugriff auf diese Adresse.",
    apiResponseFailed: "Die SubKit-API hat die Anfrage abgelehnt.",
    collectionRejected:
      "SubKit hat den Clip abgelehnt. Dein Entwurf bleibt gespeichert. Prüfe Kategorie und Inhalt und versuche es erneut.",
    connectionRetrySucceeded: "Verbindung aktiv. Kategorien wurden aktualisiert.",
    checkingConnection: "Einstellungen gespeichert. Verbindung wird geprüft …",
    connectionVerified: "Verbindung geprüft. Kategorien geladen und Sammelrecht bestätigt.",
    connectionReadOnlyVerified:
      "Verbindung steht. Die Engine kann noch nicht prüfen, ob dein Schlüssel Clips speichern darf. Beim Sammeln wird das geprüft.",
    categoryUnavailable:
      "Die gespeicherte Kategorie ist nicht verfügbar. Wähle eine andere Kategorie.",
    categoriesUnavailable: "Kategorien gerade nicht verfügbar",
    categoriesLoading: "Kategorien werden geladen.",
    destinationUnavailable: "Wähle eine gültige Kategorie, bevor du sammelst.",
    checkConnection: "Verbindung prüfen",
    emptyPreview: "Markiere den gewünschten Text auf der Seite und erfasse ihn erneut.",
    attemptUncertain:
      "Der vorige Speicherversuch ist unklar. Prüfe den Entwurf und starte einen neuen Versuch.",
    permissionDenied: "Erlaube den Zugriff auf diese Engine, um die Verbindung zu speichern.",
    invalidEngine: "Nutze HTTPS oder HTTP auf localhost.",
    keyRequired: "Gib einen API-Schlüssel für die neue Engine ein.",
    savedConnection: "Einstellungen gespeichert. Verbindung noch nicht geprüft.",
    keyCleared: "API-Schlüssel gelöscht",
    retryAttempt: "Neuen Speicherversuch starten",
    previousSaved: "Der vorige Inhalt wurde gespeichert. Deine Änderungen sind noch ein Entwurf.",
    capturedFrom: "Erfasst von",
    drafts: "Entwürfe",
    currentPage: "Aktuelle Seite",
    otherDraft: "Anderer Entwurf",
    contentPreview: "Vorschau",
    contentSize: "Umfang",
    description: "Beschreibung",
    transcript: "Transkript",
    transcriptUnavailable: "Kein Transkript verfügbar.",
    contentChanged:
      "Der Markdown-Text wurde bearbeitet. Passe die Abschnitte erst nach dem Neu-Erfassen an.",
    mainContentUnavailable:
      "Der Hauptinhalt konnte nicht zuverlässig erfasst werden. Markiere den relevanten Text auf der Seite und wähle dann Neu erfassen.",
    metadataUnavailable:
      "Einige Seiteninformationen konnten nicht gelesen werden. Prüfe Titel und Quelle.",
    articleFallback:
      "Der Inhalt wurde vereinfacht als Text erfasst. Prüfe die Vorschau auf Vollständigkeit.",
    selectionEmpty:
      "Es wurde kein Text erfasst. Klicke auf „Neu erfassen“, um die Seite zu sammeln. Für einen Ausschnitt markiere vorher den gewünschten Text.",
    words: "Wörter",
    characters: "Zeichen",
    reopenCapture: "Öffne den Clipper über die Symbolleiste auf dieser Seite erneut.",
    help: "Hilfe",
    helpLabel: "Hilfe zum Web Clipper öffnen",
    intro: "Deine Zugangsdaten bleiben in dieser Browser-Erweiterung.",
    languageField: "Sprache",
    settingsTitle: "SubKit Clipper – Einstellungen",
  },
  en: {
    title: "Collect in SubKit",
    note: "Why is this interesting? (optional)",
    details: "Details and edit content",
    review: "Review in chat",
    reviewPrompt:
      "Review my new {collection} entries. Which ones help us? Propose what we should retain, as knowledge or as a skill, with its sources.",
    reviewItemPrompt:
      "Review this collected item. Assess its usefulness and prepare a proposal with its source and destination, as knowledge or as a skill, for confirmation.",
    journey: "Collect → review in chat → confirm admission → knowledge or skill",
    notKnowledge: "Not yet admitted as knowledge or a skill.",
    savedForReview: "Collected for review",
    retryPending: "Saving is not confirmed yet. Retry; your draft remains available.",
    heading: "Collect for later",
    setup: "Set up connection",
    category: "Category",
    newCategory: "New category",
    categoryName: "New category",
    save: "Collect",
    retry: "Try again",
    settings: "Settings",
    saved: "Collected",
    duplicate: "This clip already exists.",
    replace: "Replace",
    copy: "Save a copy",
    content: "Markdown",
    titleField: "Title",
    sourceField: "Source address",
    error: "The draft remains on this device.",
    connection: "Connection",
    engine: "Engine address",
    key: "API key",
    saveConnection: "Save connection",
    clearKey: "Clear API key",
    author: "Source author",
    publishedAt: "Published at",
    discard: "Discard draft",
    newCapture: "Capture again",
    captureFailed: "The page could not be captured.",
    draftOtherEngine: "This draft belongs to a different engine.",
    needsSettings: "Set an engine address and API key first.",
    categoryRequired: "Enter a valid category.",
    needsClipApi: "Collecting is not available here.",
    intakeUnavailable: "Collecting is currently unavailable. Your draft remains saved.",
    invalidApiKey:
      "The API key is invalid or expired. Create a key with the “Web Clipper” preset under “API access” in the Cockpit. Save it in the connection settings with the gear.",
    missingIntakeReadPermission:
      "The API key lacks intake:read. Create a key with the “Web Clipper” preset under “API access” in the Cockpit. Save it in the connection settings with the gear.",
    missingIntakeWritePermission:
      "The connection works, but the API key lacks intake:write. Create a key with the “Web Clipper” preset under “API access” in the Cockpit, then save it here. Your draft remains available.",
    connectionFailed:
      "The SubKit API could not be reached. Check the engine address, internet connection, and Chrome access to this address.",
    apiResponseFailed: "The SubKit API rejected the request.",
    collectionRejected:
      "SubKit rejected the clip. Your draft remains saved. Check its category and content, then retry.",
    connectionRetrySucceeded: "Connection is active. Categories were refreshed.",
    checkingConnection: "Settings saved. Checking connection …",
    connectionVerified:
      "Connection checked. Categories loaded and collection permission confirmed.",
    connectionReadOnlyVerified:
      "Connection is active. This engine cannot check whether your key may save clips yet. That is checked when you collect.",
    categoryUnavailable: "The saved category is unavailable. Choose another category.",
    categoriesUnavailable: "Categories currently unavailable",
    categoriesLoading: "Loading categories.",
    destinationUnavailable: "Choose a valid category before collecting.",
    checkConnection: "Check connection",
    emptyPreview: "Select the text you want on the page and capture it again.",
    attemptUncertain:
      "The previous save may be incomplete. Review the draft and start a new save attempt.",
    permissionDenied: "Allow access to this engine to save the connection.",
    invalidEngine: "Use an HTTPS address or HTTP on localhost.",
    keyRequired: "Enter an API key for the new engine.",
    savedConnection: "Settings saved. Connection has not been checked yet.",
    keyCleared: "API key cleared",
    retryAttempt: "Start a new save attempt",
    previousSaved: "The previous content was saved. Your changes remain a draft.",
    capturedFrom: "Captured from",
    drafts: "Drafts",
    currentPage: "Current page",
    otherDraft: "Another draft",
    contentPreview: "Preview",
    contentSize: "Size",
    description: "Description",
    transcript: "Transcript",
    transcriptUnavailable: "No transcript is available.",
    contentChanged: "The Markdown was edited. Capture again before changing included sections.",
    mainContentUnavailable:
      "The main content could not be captured reliably. Select the relevant text on the page, then choose Capture again.",
    metadataUnavailable: "Some page information could not be read. Check the title and source.",
    articleFallback:
      "The content was captured as simplified text. Check the preview for completeness.",
    selectionEmpty:
      "No text was captured. Click ‘Capture again’ to collect the page. For an excerpt, select the text on the page first.",
    words: "words",
    characters: "characters",
    reopenCapture: "Open the clipper from the toolbar on this page again.",
    help: "Help",
    helpLabel: "Open Web Clipper help",
    intro: "Your credentials stay in this browser extension.",
    languageField: "Language",
    settingsTitle: "SubKit Clipper settings",
  },
} as const;

export type Language = keyof typeof copy;

export function language(value?: string): Language {
  return value === "de" || (!value && navigator.language.toLowerCase().startsWith("de"))
    ? "de"
    : "en";
}

export function applyText(values: Copy): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n as keyof Copy | undefined;
    if (key) element.textContent = values[key];
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((element) => {
    const key = element.dataset.i18nLabel as keyof Copy | undefined;
    if (key) element.setAttribute("aria-label", values[key]);
  });
}

export const helpPath = "/cockpit/docs/web-clipper";

export function helpUrl(engineUrl: string | undefined): string | undefined {
  return engineUrl ? apiUrl(engineUrl, helpPath) : undefined;
}

export function showHelpLink(link: HTMLAnchorElement | null, engineUrl: string | undefined): void {
  if (!link) return;
  const url = helpUrl(engineUrl);
  link.hidden = !url;
  link.href = url || "about:blank";
}

export function offersHelp(values: Copy, message: string): boolean {
  return [
    values.invalidApiKey,
    values.missingIntakeReadPermission,
    values.missingIntakeWritePermission,
    values.connectionFailed,
    values.apiResponseFailed,
    values.intakeUnavailable,
  ].some((troubleshooting) => message.startsWith(troubleshooting));
}

export interface WorkerCopy {
  page: string;
  selection: string;
  engineRequired: string;
  captureFailed: string;
  noActiveTab: string;
  draftMissing: string;
  draftIdentityChanged: string;
  draftInvalid: string;
  pageChanged: string;
  engineChanged: string;
}

export const workerCopy: Record<Language, WorkerCopy> = {
  de: {
    page: "Seite in SubKit sichern",
    selection: "Auswahl in SubKit sichern",
    engineRequired: "Lege vor dem Erfassen eine Engine-Adresse fest.",
    captureFailed: "Die Seite konnte nicht erfasst werden.",
    noActiveTab: "Es ist kein aktiver Tab verfügbar.",
    draftMissing: "Der Entwurf ist nicht mehr verfügbar.",
    draftIdentityChanged: "Der Entwurf gehört nicht mehr zu dieser Seite oder Engine.",
    draftInvalid: "Der Entwurf ist ungültig.",
    pageChanged: "Die Seite hat sich während der Erfassung geändert. Erfasse sie erneut.",
    engineChanged:
      "Die Engine-Adresse hat sich während der Erfassung geändert. Erfasse die Seite erneut.",
  },
  en: {
    page: "Save page to SubKit",
    selection: "Save selection to SubKit",
    engineRequired: "Set an engine address before capturing.",
    captureFailed: "The page could not be captured.",
    noActiveTab: "No active tab is available.",
    draftMissing: "The draft is no longer available.",
    draftIdentityChanged: "The draft identity changed.",
    draftInvalid: "The draft is invalid.",
    pageChanged: "The page changed while it was being captured. Capture it again.",
    engineChanged:
      "The engine address changed while the page was being captured. Capture it again.",
  },
};

export function intakeReviewPrompt(values: Copy, collection: string): string {
  return values.reviewPrompt.replace("{collection}", collection);
}

export function intakeItemReviewPrompt(values: Copy): string {
  return values.reviewItemPrompt;
}

export function intakeItemReviewParams(values: Copy, itemId: string): Record<string, string> {
  return {
    intake_item_ids: itemId,
    references: `intake_item:${itemId}`,
    prompt: intakeItemReviewPrompt(values),
  };
}

export function contentSummary(value: string): { characters: number; words: number } {
  return {
    characters: value.length,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
  };
}

export function previewText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export interface PreviewBlock {
  kind: "heading" | "list" | "paragraph";
  text: string;
}

function previewInline(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export function previewBlocks(value: string): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = previewInline(paragraph.join(" "));
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  for (const line of value.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const list = line.match(/^\s*[-*+]\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: previewInline(heading[1]!) });
    } else if (list) {
      flush();
      blocks.push({ kind: "list", text: previewInline(list[1]!) });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export function isCapturablePageUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isSourceWindow(sourceWindowId: number | undefined, windowId: number): boolean {
  return sourceWindowId === undefined || sourceWindowId === windowId;
}

export interface CapturedSections {
  description?: string;
  transcript?: string;
}

export interface GeneratedSectionSelection {
  description: boolean;
  transcript: boolean;
}

function composedSections(
  sections: CapturedSections,
  selection: GeneratedSectionSelection,
  headings: { description: string; transcript: string },
): string {
  const parts: string[] = [];
  if (selection.description && sections.description) {
    parts.push(`## ${headings.description}\n\n${sections.description}`);
  }
  if (selection.transcript && sections.transcript) {
    parts.push(`## ${headings.transcript}\n\n${sections.transcript}`);
  }
  return parts.join("\n\n");
}

export function generatedSectionSelection(
  body: string,
  sections: CapturedSections,
): GeneratedSectionSelection | undefined {
  const choices: GeneratedSectionSelection[] = [
    { description: Boolean(sections.description), transcript: Boolean(sections.transcript) },
    { description: Boolean(sections.description), transcript: false },
    { description: false, transcript: Boolean(sections.transcript) },
    { description: false, transcript: false },
  ];
  const headings = [
    { description: copy.de.description, transcript: copy.de.transcript },
    { description: copy.en.description, transcript: copy.en.transcript },
  ];
  return choices.find((selection) =>
    headings.some((labels) => composedSections(sections, selection, labels) === body),
  );
}

export function captureDiagnosticMessages(
  diagnostics: CaptureDiagnostic[] | undefined,
  text: Copy,
): string[] {
  const messages: Record<CaptureDiagnostic["code"], string> = {
    metadata_unavailable: text.metadataUnavailable,
    article_fallback: text.articleFallback,
    main_content_unavailable: text.mainContentUnavailable,
    selection_unavailable: text.selectionEmpty,
    youtube_transcript_unavailable: text.transcriptUnavailable,
    youtube_transcript_failed: text.transcriptUnavailable,
  };
  return [
    ...new Set((diagnostics || []).map((diagnostic) => messages[diagnostic.code]).filter(Boolean)),
  ];
}
