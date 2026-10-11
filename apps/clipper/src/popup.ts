import { ApiError, CollectionPermissionError, connectionErrorMessage, IntakeApi } from "./api.ts";
import { chromeApi } from "./chrome-api.ts";
import { apiUrl, isDraftForEngine, loadSettings, normalizeSourceUrl } from "./clipper.ts";
import { intakeSubmission } from "./intake.ts";
import type { CaptureError, Draft } from "./types.ts";
import {
  applyText,
  type Copy,
  captureDiagnosticMessages,
  contentSummary,
  copy,
  generatedSectionSelection,
  intakeItemReviewParams,
  isCapturablePageUrl,
  isSourceWindow,
  language,
  previewBlocks,
} from "./ui.ts";

const captureErrorKey = "captureError";
const form = document.querySelector<HTMLFormElement>("#clip-form");
const category = document.querySelector<HTMLSelectElement>("#category");
const categoryInput = document.querySelector<HTMLInputElement>("#category-name");
const title = document.querySelector<HTMLInputElement>("#title");
const sourceUrl = document.querySelector<HTMLAnchorElement>("#source-url");
const note = document.querySelector<HTMLTextAreaElement>("#note");
const review = document.querySelector<HTMLButtonElement>("#review");
const savedClip = document.querySelector<HTMLElement>("#saved-clip");
const savedClipTitle = document.querySelector<HTMLElement>("#saved-clip-title");
const savedClipSource = document.querySelector<HTMLAnchorElement>("#saved-clip-source");
const author = document.querySelector<HTMLInputElement>("#author");
const publishedAt = document.querySelector<HTMLInputElement>("#published-at");
const content = document.querySelector<HTMLTextAreaElement>("#content");
const status = document.querySelector<HTMLElement>("#status");
const checkConnection = document.querySelector<HTMLButtonElement>("#check-connection");
const setup = document.querySelector<HTMLButtonElement>("#setup");
const discard = document.querySelector<HTMLButtonElement>("#discard");
const captureAgain = document.querySelector<HTMLButtonElement>("#capture-again");
const draftPicker = document.querySelector<HTMLSelectElement>("#draft-picker");
const draftPickerLabel = document.querySelector<HTMLElement>("#draft-picker-label");
const captureOrigin = document.querySelector<HTMLElement>("#capture-origin");
const videoSections = document.querySelector<HTMLElement>("#video-sections");
const includeDescription = document.querySelector<HTMLInputElement>("#include-description");
const includeTranscript = document.querySelector<HTMLInputElement>("#include-transcript");
const transcriptState = document.querySelector<HTMLElement>("#transcript-state");
const contentSize = document.querySelector<HTMLElement>("#content-size");
const contentPreview = document.querySelector<HTMLElement>("#content-preview");

let draft: Draft | undefined;
let categories: string[] = [];
let savedReviewUrl: string | undefined;
let text: Copy = copy.de;
let draftWrite = Promise.resolve();
let saving = false;
let recapturing = false;
let generatedBody: string | undefined;
let sourceRefresh = 0;
let pendingSourceRefresh: { tabId: number; url?: string } | undefined;
let sourceRefreshReady = false;
let sourceWindowId: number | undefined;
let categoriesState: "idle" | "loading" | "ready" | "error" = "idle";
let categoryLoad = 0;
let connectionReady = false;
let connectionFailure: unknown;

function connectionFailureMessage(error: unknown): string {
  return connectionErrorMessage(error, text);
}

function collectionFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return text.invalidApiKey;
    if (error.status === 403) return text.missingIntakeWritePermission;
    if ([400, 422].includes(error.status)) return text.collectionRejected;
    if (error.status === 409) return text.duplicate;
    return `${text.apiResponseFailed} (HTTP ${error.status}${error.traceId ? `, Trace: ${error.traceId}` : ""})`;
  }
  return connectionFailureMessage(error);
}

function setStatus(message: string, isError = false, showConnection = false): void {
  if (status) {
    status.textContent = message;
    status.dataset.error = isError ? "true" : "false";
  }
  if (checkConnection) checkConnection.hidden = !showConnection;
}

function clearSavedClip(): void {
  if (savedClip) savedClip.hidden = true;
  if (savedClipTitle) savedClipTitle.textContent = "";
  if (savedClipSource) {
    savedClipSource.textContent = "";
    savedClipSource.removeAttribute("href");
  }
  delete form?.dataset.saved;
}

function showSavedClip(current: Draft): void {
  if (savedClipTitle) savedClipTitle.textContent = current.metadata.title;
  if (savedClipSource) {
    savedClipSource.href = current.captureUrl;
    savedClipSource.textContent = current.captureUrl;
  }
  if (savedClip) savedClip.hidden = false;
  if (form) form.dataset.saved = "true";
}

function showCaptureStatus(_current: Draft, captureMessage?: string): void {
  if (categoriesState === "error") {
    setStatus(connectionFailureMessage(connectionFailure), true, true);
    return;
  }
  if (captureMessage) setStatus(captureMessage, true);
  else setStatus("");
}

function isValidCategory(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 40 && value !== "platform";
}

function draftFromForm(): Draft | undefined {
  if (!draft || draft.intakeAttempt) return draft;
  const current = {
    ...draft,
    metadata: { ...draft.metadata, title: title?.value.trim() || draft.metadata.title },
    body: content?.value ?? draft.body,
    note: note?.value || "",
  };
  if (!category || categoriesState !== "ready" || category.value === "__missing__") return current;
  const { category: _, ...base } = current;
  if (category.value === "__new__") {
    const value = categoryInput?.value.trim() || "";
    return value ? { ...base, category: value } : base;
  }
  return category.value ? { ...base, category: category.value } : base;
}

function validDestination(): boolean {
  if (!category || categoriesState !== "ready") return false;
  if (category.value === "__missing__") return false;
  return category.value !== "__new__" || Boolean(categoryInput?.value.trim());
}

function canSave(): boolean {
  return Boolean(
    draft?.body.trim() &&
      !saving &&
      connectionReady &&
      categoriesState === "ready" &&
      validDestination(),
  );
}

function updateBusyState(): void {
  form
    ?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    )
    .forEach((element) => {
      element.disabled = saving || Boolean(draft?.intakeAttempt);
    });
  if (category)
    category.disabled = saving || Boolean(draft?.intakeAttempt) || categoriesState !== "ready";
  if (categoryInput)
    categoryInput.disabled = saving || Boolean(draft?.intakeAttempt) || categoriesState !== "ready";
  if (draftPicker) draftPicker.disabled = saving;
  const saveButton = document.querySelector<HTMLButtonElement>("#save");
  if (saveButton) {
    saveButton.disabled = !canSave();
    saveButton.textContent = draft?.intakeAttempt ? text.retry : text.save;
  }
  if (captureAgain) captureAgain.disabled = saving || Boolean(draft?.intakeAttempt);
  if (discard) discard.disabled = saving;
}

function queueDraft(next: Draft): Promise<void> {
  const priorRevision = draft?.id === next.id ? draft.writeRevision || 0 : 0;
  const draftWithRevision = {
    ...next,
    writeRevision: Math.max(priorRevision, next.writeRevision || 0) + 1,
  };
  draft = draftWithRevision;
  const write = chromeApi.runtime.sendMessage({
    type: "save-draft",
    draft: draftWithRevision,
  }) as Promise<void>;
  draftWrite = draftWrite.then(
    () => write,
    () => write,
  );
  return draftWrite;
}

function persistenceFailure(_error: unknown): void {
  setStatus(text.error, true);
}

function persistFromInput(): void {
  void persist().catch(persistenceFailure);
}

function queuedSourceRefresh(): void {
  const pending = pendingSourceRefresh;
  pendingSourceRefresh = undefined;
  if (pending) scheduleSourceRefresh(pending.tabId, pending.url);
}

function scheduleSourceRefresh(tabId: number, url?: string): void {
  if (!sourceRefreshReady) return;
  if (saving || recapturing) {
    pendingSourceRefresh = { tabId, ...(url ? { url } : {}) };
    return;
  }
  const request = ++sourceRefresh;
  void refreshSource(tabId, url, request);
}

async function rememberSourceWindow(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    sourceWindowId = (await chromeApi.tabs.get(tabId)).windowId;
  } catch {
    sourceWindowId = undefined;
  }
}

async function refreshSource(
  tabId: number,
  knownUrl: string | undefined,
  request: number,
): Promise<void> {
  try {
    const tabUrl = knownUrl || (await chromeApi.tabs.get(tabId)).url;
    if (!tabUrl) {
      if (request === sourceRefresh) setStatus(text.reopenCapture, true);
      return;
    }
    if (!isCapturablePageUrl(tabUrl)) return;
    if (draft?.captureTabId === tabId && draft.captureUrl === normalizeSourceUrl(tabUrl)) return;
    await persist();
    await draftWrite;
    if (request !== sourceRefresh) return;
    const captured = (await chromeApi.runtime.sendMessage({
      type: "start-capture",
      mode: "article",
      captureTabId: tabId,
    })) as Draft;
    if (request !== sourceRefresh) return;
    draft = captured;
    categoriesState = "loading";
    await rememberSourceWindow(captured.captureTabId);
    if (request !== sourceRefresh) return;
    replaceDraftRoute(captured.id);
    setForm(captured);
    await loadCategories();
    await refreshDraftPicker(captured.id);
    showCaptureStatus(captured);
  } catch {
    if (request === sourceRefresh) setStatus(text.reopenCapture, true);
  }
}

async function persist(): Promise<Draft | undefined> {
  const next = draftFromForm();
  if (!next) return undefined;
  await queueDraft(next);
  return next;
}

function setForm(next: Draft): void {
  clearSavedClip();
  if (title) title.value = next.metadata.title;
  if (sourceUrl) {
    sourceUrl.hidden = false;
    sourceUrl.href = next.captureUrl;
    sourceUrl.textContent = next.captureUrl;
  }
  if (note) note.value = next.note || "";
  if (review) review.hidden = true;
  savedReviewUrl = undefined;
  if (author) author.value = next.metadata.author || "";
  if (publishedAt) publishedAt.value = next.metadata.publishedAt || "";
  if (content) content.value = next.body;
  if (categoryInput) categoryInput.value = next.category || "";
  generatedBody = next.sections
    ? generatedSectionSelection(next.body, next.sections)
      ? next.body
      : undefined
    : next.body;
  updateContentDetails();
  updateCaptureDetails(next);
  updateBusyState();
}

function clearForm(): void {
  if (title) title.value = "";
  if (sourceUrl) {
    sourceUrl.hidden = true;
    sourceUrl.removeAttribute("href");
    sourceUrl.textContent = "";
  }
  if (note) note.value = "";
  if (author) author.value = "";
  if (publishedAt) publishedAt.value = "";
  if (content) content.value = "";
  if (categoryInput) categoryInput.value = "";
  if (captureOrigin) captureOrigin.hidden = true;
  if (videoSections) videoSections.hidden = true;
  generatedBody = undefined;
  updateContentDetails();
  updateBusyState();
}

function sectionBody(current: Draft): string {
  const sections = current.sections;
  if (!sections) return current.body;
  const parts: string[] = [];
  if (includeDescription?.checked && sections.description) {
    parts.push(`## ${text.description}\n\n${sections.description}`);
  }
  if (includeTranscript?.checked && sections.transcript) {
    parts.push(`## ${text.transcript}\n\n${sections.transcript}`);
  }
  return parts.join("\n\n");
}

function updateContentDetails(): void {
  const value = content?.value || "";
  const summary = contentSummary(value);
  if (contentSize)
    contentSize.textContent = `${text.contentSize}: ${summary.words} ${text.words}, ${summary.characters} ${text.characters}`;
  if (contentPreview) {
    contentPreview.replaceChildren();
    if (!value.trim()) {
      const empty = document.createElement("p");
      empty.textContent = text.emptyPreview;
      contentPreview.append(empty);
      return;
    }
    let list: HTMLUListElement | undefined;
    for (const block of previewBlocks(value)) {
      if (block.kind === "list") {
        if (!list) {
          list = document.createElement("ul");
          contentPreview.append(list);
        }
        const item = document.createElement("li");
        item.textContent = block.text;
        list.append(item);
        continue;
      }
      list = undefined;
      const element = document.createElement(block.kind === "heading" ? "strong" : "p");
      element.textContent = block.text;
      contentPreview.append(element);
    }
  }
}

function updateCaptureDetails(current: Draft): void {
  const notice = document.querySelector<HTMLElement>("#capture-diagnostics");
  if (notice) {
    const messages = captureDiagnosticMessages(current.diagnostics, text);
    notice.hidden = messages.length === 0;
    notice.textContent = messages.join(" ");
  }
  if (captureOrigin) {
    captureOrigin.hidden = false;
    captureOrigin.textContent = `${text.capturedFrom}: ${current.captureUrl}`;
  }
  const sections = current.sections;
  if (videoSections) videoSections.hidden = !sections;
  if (!sections) return;
  const selection = generatedSectionSelection(current.body, sections);
  if (includeDescription) includeDescription.checked = selection?.description || false;
  if (includeTranscript) includeTranscript.checked = selection?.transcript || false;
  if (includeDescription) includeDescription.disabled = !sections.description;
  if (includeTranscript) includeTranscript.disabled = !sections.transcript;
  if (transcriptState) {
    transcriptState.hidden = Boolean(sections.transcript && !sections.transcriptLanguage);
    transcriptState.textContent = sections.transcript
      ? sections.transcriptLanguage
        ? `${text.transcript} (${sections.transcriptLanguage})`
        : ""
      : text.transcriptUnavailable;
  }
}

async function refreshDraftPicker(selectedId?: string): Promise<void> {
  if (!draftPicker) return;
  const drafts = (await chromeApi.runtime.sendMessage({ type: "list-drafts" })) as Draft[];
  draftPicker.replaceChildren();
  if (!selectedId && drafts.length) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = text.drafts;
    draftPicker.append(placeholder);
  }
  for (const item of drafts) {
    const option = document.createElement("option");
    option.value = item.id;
    const ownPage = item.id === selectedId;
    option.textContent = `${ownPage ? text.currentPage : text.otherDraft}: ${item.metadata.title}`;
    draftPicker.append(option);
  }
  if (draftPickerLabel) draftPickerLabel.hidden = Boolean(selectedId && drafts.length < 2);
  if (selectedId) draftPicker.value = selectedId;
}

async function loadStoredDraft(id: string): Promise<Draft | undefined> {
  return (await chromeApi.runtime.sendMessage({ type: "load-draft", draftId: id })) as
    | Draft
    | undefined;
}

async function clearStoredDraft(id: string): Promise<void> {
  await chromeApi.runtime.sendMessage({ type: "clear-draft", draftId: id });
}

function replaceDraftRoute(id: string): void {
  const url = new URL(location.href);
  url.searchParams.set("draft", id);
  url.searchParams.delete("tab");
  history.replaceState(null, "", url.toString());
}

async function loadCategories(): Promise<void> {
  const request = ++categoryLoad;
  categoriesState = "loading";
  connectionReady = false;
  if (category) {
    category.replaceChildren(new Option(text.categoriesLoading, ""));
    category.value = "";
  }
  if (categoryInput) categoryInput.hidden = true;
  updateBusyState();
  try {
    const settings = await loadSettings(chromeApi.storage.local);
    if (request !== categoryLoad) return;
    if (
      !settings.engineUrl ||
      !settings.apiKey ||
      (draft && !isDraftForEngine(draft, settings.engineUrl))
    ) {
      categoriesState = "error";
      return;
    }
    const api = new IntakeApi(settings.engineUrl, settings.apiKey);
    const [vocabulary, preference] = await Promise.all([api.categories(), api.defaultCategory()]);
    if (request !== categoryLoad) return;
    if (preference.can_collect === false) throw new CollectionPermissionError();
    connectionFailure = undefined;
    connectionReady = true;
    categories = [
      ...new Set([
        preference.category,
        ...vocabulary.categories.map((item) => item.category),
        ...(draft?.category ? [draft.category] : []),
      ]),
    ];
    if (!category) return;
    category.replaceChildren();
    const savedCategory = draft?.category;
    if (savedCategory && !categories.includes(savedCategory)) {
      const missing = new Option(text.categoryUnavailable, "__missing__");
      missing.disabled = true;
      missing.selected = true;
      category.append(missing);
    }
    for (const value of categories) category.append(new Option(value, value));
    category.append(new Option(text.newCategory, "__new__"));
    if (savedCategory && categories.includes(savedCategory)) category.value = savedCategory;
    else if (savedCategory) category.value = "__missing__";
    else category.value = preference.category;
    if (categoryInput) {
      categoryInput.hidden = category.value !== "__new__";
      categoryInput.value = category.value === "__new__" ? savedCategory || "" : "";
    }
    categoriesState = "ready";
  } catch (error) {
    if (request !== categoryLoad) return;
    connectionFailure = error;
    categoriesState = "error";
    if (category) category.replaceChildren(new Option(text.categoriesUnavailable, ""));
  } finally {
    if (request === categoryLoad) updateBusyState();
  }
}

async function save(): Promise<void> {
  if (saving) return;
  if (!draft?.body.trim()) {
    setStatus(text.emptyPreview, true);
    updateBusyState();
    return;
  }
  if (!connectionReady) {
    setStatus(text.intakeUnavailable, true, true);
    updateBusyState();
    return;
  }
  if (categoriesState !== "ready" || !validDestination()) {
    setStatus(
      categoriesState === "error" ? text.intakeUnavailable : text.destinationUnavailable,
      true,
      categoriesState === "error",
    );
    updateBusyState();
    return;
  }
  saving = true;
  updateBusyState();
  try {
    let current = await persist();
    const settings = await loadSettings(chromeApi.storage.local);
    if (!current || !settings.engineUrl || !settings.apiKey) {
      await chromeApi.runtime.openOptionsPage();
      return;
    }
    if (!isDraftForEngine(current, settings.engineUrl)) throw new Error(text.draftOtherEngine);
    if (!current.body.trim()) throw new Error(text.emptyPreview);
    const api = new IntakeApi(settings.engineUrl, settings.apiKey);
    if (!current.intakeAttempt) {
      if (!current.category || !isValidCategory(current.category))
        throw new Error(text.categoryRequired);
      current = { ...current, intakeAttempt: intakeSubmission(current, crypto.randomUUID()) };
      await queueDraft(current);
    }
    const attempt = current.intakeAttempt;
    if (!attempt) throw new Error(text.error);
    const item = await api.collect(attempt);
    await clearStoredDraft(current.id);
    draft = undefined;
    clearForm();
    showSavedClip(current);
    await refreshDraftPicker();
    const categoryName = item.category || current.category || "inbox";
    savedReviewUrl = apiUrl(
      settings.engineUrl,
      `/cockpit/chat/new?${new URLSearchParams(intakeItemReviewParams(text, item.id))}`,
    );
    if (review) review.hidden = false;
    setStatus(`${text.saved}: ${categoryName}. ${text.notKnowledge}`);
  } catch (error) {
    if (error instanceof ApiError && [400, 401, 403, 404, 422].includes(error.status) && draft) {
      const { intakeAttempt: _, ...retryable } = draft;
      await queueDraft({ ...retryable, state: "ready" });
    }
    setStatus(
      draft?.intakeAttempt ? text.retryPending : collectionFailureMessage(error),
      true,
      !draft?.intakeAttempt,
    );
  } finally {
    saving = false;
    updateBusyState();
    if (draft && !draft.intakeAttempt) updateCaptureDetails(draft);
    queuedSourceRefresh();
  }
}

async function discardAndCapture(): Promise<void> {
  if (recapturing) return;
  recapturing = true;
  try {
    await persist();
    await draftWrite;
    draft = (await chromeApi.runtime.sendMessage({
      type: "discard-and-capture",
      mode: "auto",
      ...(draft ? { draftId: draft.id } : {}),
    })) as Draft;
    if (draft) {
      categoriesState = "loading";
      replaceDraftRoute(draft.id);
      setForm(draft);
      await loadCategories();
      await refreshDraftPicker(draft.id);
      showCaptureStatus(draft);
    }
  } catch (_error) {
    setStatus(text.captureFailed, true);
  } finally {
    recapturing = false;
    queuedSourceRefresh();
  }
}

async function initialize(): Promise<void> {
  const settings = await loadSettings(chromeApi.storage.local);
  text = copy[language(settings.language)];
  document.documentElement.lang = language(settings.language);
  applyText(text);
  const stored = await chromeApi.storage.local.get(captureErrorKey);
  const captureError = stored[captureErrorKey] as CaptureError | undefined;
  const draftId = new URL(location.href).searchParams.get("draft");
  draft = draftId ? await loadStoredDraft(draftId) : undefined;
  await refreshDraftPicker(draft?.id);
  if (!draft) {
    try {
      draft = (await chromeApi.runtime.sendMessage({
        type: "start-capture",
        mode: "auto",
      })) as Draft;
    } catch (error) {
      setStatus(
        captureError?.message || (error instanceof Error ? error.message : text.captureFailed),
        true,
      );
      return;
    }
  }
  replaceDraftRoute(draft.id);
  setForm(draft);
  await refreshDraftPicker(draft.id);
  await rememberSourceWindow(draft.captureTabId);
  sourceRefreshReady = true;
  if (!settings.engineUrl || !settings.apiKey) {
    setStatus(text.needsSettings, true);
    updateBusyState();
    return;
  }
  if (!isDraftForEngine(draft, settings.engineUrl)) {
    setStatus(text.draftOtherEngine, true);
    updateBusyState();
    return;
  }
  connectionReady = true;
  await loadCategories();
  showCaptureStatus(draft, captureError?.message);
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});
for (const field of [title, note, content, categoryInput]) {
  field?.addEventListener("input", () => {
    persistFromInput();
    if (field === content) updateContentDetails();
    updateBusyState();
  });
}
category?.addEventListener("change", () => {
  if (categoryInput) categoryInput.hidden = category.value !== "__new__";
  persistFromInput();
  updateBusyState();
});
review?.addEventListener("click", () => {
  if (savedReviewUrl) void chromeApi.tabs.create({ url: savedReviewUrl });
});
discard?.addEventListener("click", () => {
  if (!draft) return;
  const discarded = draft;
  void draftWrite
    .then(() => clearStoredDraft(discarded.id))
    .then(() => {
      draft = undefined;
      clearForm();
      if (review) review.hidden = true;
      setStatus("");
      void refreshDraftPicker().catch(persistenceFailure);
    }, persistenceFailure);
});
captureAgain?.addEventListener("click", () => void discardAndCapture());
setup?.addEventListener("click", () => void chromeApi.runtime.openOptionsPage());
checkConnection?.addEventListener("click", () => {
  const current = draft;
  if (!current) return;
  void loadCategories().then(() => {
    if (categoriesState === "ready") setStatus(text.connectionRetrySucceeded);
    else showCaptureStatus(current);
  });
});

chromeApi.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (isSourceWindow(sourceWindowId, windowId)) scheduleSourceRefresh(tabId);
});
chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && tabId === draft?.captureTabId) scheduleSourceRefresh(tabId, changeInfo.url);
});

draftPicker?.addEventListener("change", () => {
  const id = draftPicker.value;
  if (!id || id === draft?.id) return;
  void draftWrite
    .then(() => {
      const url = new URL(location.href);
      url.searchParams.set("draft", id);
      url.searchParams.delete("tab");
      location.assign(url.toString());
    })
    .catch(persistenceFailure);
});

for (const toggle of [includeDescription, includeTranscript]) {
  toggle?.addEventListener("change", () => {
    if (!draft?.sections) return;
    if (content?.value !== generatedBody) {
      updateCaptureDetails(draft);
      setStatus(text.contentChanged, true);
      return;
    }
    const nextBody = sectionBody(draft);
    if (!nextBody) return;
    draft = { ...draft, body: nextBody };
    if (content) content.value = nextBody;
    generatedBody = nextBody;
    updateContentDetails();
    void queueDraft(draft).catch(persistenceFailure);
  });
}

void initialize().catch(persistenceFailure);
