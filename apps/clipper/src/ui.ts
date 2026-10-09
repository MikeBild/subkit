export interface Copy {
  title: string;
  heading: string;
  setup: string;
  source: string;
  newCollection: string;
  collectionName: string;
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
  collectionRequired: string;
  needsClipApi: string;
  loadFailed: string;
  attemptUncertain: string;
  permissionDenied: string;
  invalidEngine: string;
  keyRequired: string;
  savedConnection: string;
  keyCleared: string;
  retryAttempt: string;
  previousSaved: string;
}

export const copy: Record<"de" | "en", Copy> = {
  de: {
    title: "In SubKit sichern",
    heading: "In Wissen sichern",
    setup: "Verbindung einrichten",
    source: "Wissenssammlung",
    newCollection: "Neue Sammlung",
    collectionName: "Name der Sammlung",
    save: "Sichern",
    retry: "Erneut versuchen",
    settings: "Einstellungen",
    saved: "Gesichert",
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
    author: "Autor",
    publishedAt: "Veröffentlicht am",
    discard: "Entwurf verwerfen",
    newCapture: "Neu erfassen",
    captureFailed: "Die Seite konnte nicht erfasst werden.",
    draftOtherEngine: "Dieser Entwurf gehört zu einer anderen Engine.",
    needsSettings: "Lege zuerst eine Engine-Adresse und einen API-Schlüssel fest.",
    collectionRequired: "Gib einen Namen für die Sammlung ein.",
    needsClipApi: "Diese Engine benötigt die aktuelle Clipper-API.",
    loadFailed: "Sammlungen konnten nicht geladen werden.",
    attemptUncertain:
      "Der vorige Speicherversuch ist unklar. Prüfe den Entwurf und starte einen neuen Versuch.",
    permissionDenied: "Erlaube den Zugriff auf diese Engine, um die Verbindung zu speichern.",
    invalidEngine: "Nutze HTTPS oder HTTP auf localhost.",
    keyRequired: "Gib einen API-Schlüssel für die neue Engine ein.",
    savedConnection: "Gespeichert",
    keyCleared: "API-Schlüssel gelöscht",
    retryAttempt: "Neuen Speicherversuch starten",
    previousSaved: "Der vorige Inhalt wurde gespeichert. Deine Änderungen sind noch ein Entwurf.",
  },
  en: {
    title: "Save to SubKit",
    heading: "Save to knowledge",
    setup: "Set up connection",
    source: "Knowledge collection",
    newCollection: "New collection",
    collectionName: "Collection name",
    save: "Save",
    retry: "Try again",
    settings: "Settings",
    saved: "Saved",
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
    author: "Author",
    publishedAt: "Published at",
    discard: "Discard draft",
    newCapture: "Capture again",
    captureFailed: "The page could not be captured.",
    draftOtherEngine: "This draft belongs to a different engine.",
    needsSettings: "Set an engine address and API key first.",
    collectionRequired: "Enter a collection name.",
    needsClipApi: "This engine needs the current clip API.",
    loadFailed: "Unable to load collections.",
    attemptUncertain:
      "The previous save may be incomplete. Review the draft and start a new save attempt.",
    permissionDenied: "Allow access to this engine to save the connection.",
    invalidEngine: "Use an HTTPS address or HTTP on localhost.",
    keyRequired: "Enter an API key for the new engine.",
    savedConnection: "Saved",
    keyCleared: "API key cleared",
    retryAttempt: "Start a new save attempt",
    previousSaved: "The previous content was saved. Your changes remain a draft.",
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
}
