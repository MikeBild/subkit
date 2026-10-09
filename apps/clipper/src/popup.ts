import { ApiError, KnowledgeApi } from "./api.ts";
import { chromeApi } from "./chrome-api.ts";
import {
  attemptMatchesDocument,
  clearDraft,
  clipPath,
  isDraftForEngine,
  loadDraft,
  loadSettings,
  markdown,
  persistedCollectionSlug,
  saveDraft,
  urlHash,
} from "./clipper.ts";
import type { CaptureError, Draft, KnowledgeSource, WriteAttempt } from "./types.ts";
import { applyText, type Copy, copy, language } from "./ui.ts";

const captureErrorKey = "captureError";
const form = document.querySelector<HTMLFormElement>("#clip-form");
const source = document.querySelector<HTMLSelectElement>("#source");
const collection = document.querySelector<HTMLInputElement>("#collection-name");
const title = document.querySelector<HTMLInputElement>("#title");
const sourceUrl = document.querySelector<HTMLInputElement>("#source-url");
const author = document.querySelector<HTMLInputElement>("#author");
const publishedAt = document.querySelector<HTMLInputElement>("#published-at");
const content = document.querySelector<HTMLTextAreaElement>("#content");
const status = document.querySelector<HTMLElement>("#status");
const setup = document.querySelector<HTMLButtonElement>("#setup");
const duplicate = document.querySelector<HTMLElement>("#duplicate");
const replace = document.querySelector<HTMLButtonElement>("#replace");
const saveCopy = document.querySelector<HTMLButtonElement>("#copy");
const discard = document.querySelector<HTMLButtonElement>("#discard");
const captureAgain = document.querySelector<HTMLButtonElement>("#capture-again");
const retryAttempt = document.querySelector<HTMLButtonElement>("#retry-attempt");

let draft: Draft | undefined;
let bundles: KnowledgeSource[] = [];
let text: Copy = copy.de;
let draftWrite = Promise.resolve();
let saving = false;

function setStatus(message: string, isError = false): void {
  if (!status) return;
  status.textContent = message;
  status.dataset.error = isError ? "true" : "false";
}

function setDuplicate(hidden: boolean): void {
  if (duplicate) duplicate.hidden = hidden;
}

function setRetryAttempt(hidden: boolean): void {
  if (retryAttempt) retryAttempt.hidden = hidden;
}

function optional(value: string | undefined): Partial<{ author: string }> {
  return value?.trim() ? { author: value.trim() } : {};
}

function metadataFromForm(current: Draft): Draft["metadata"] {
  const nextAuthor = author?.value;
  const nextPublishedAt = publishedAt?.value.trim();
  const { author: _, publishedAt: __, ...base } = current.metadata;
  return {
    ...base,
    title: title?.value.trim() || current.metadata.title,
    sourceUrl: sourceUrl?.value.trim() || current.metadata.sourceUrl,
    ...optional(nextAuthor),
    ...(nextPublishedAt ? { publishedAt: nextPublishedAt } : {}),
  };
}

function draftFromForm(): Draft | undefined {
  if (!draft) return undefined;
  const {
    sourceId: _,
    collectionName: __,
    attempt: ___,
    duplicateVersion: ____,
    path: _____,
    copyPath: ______,
    ...base
  } = draft;
  const selectedSource = source?.value;
  const nextCollection = collection?.value.trim();
  const next = {
    ...base,
    metadata: metadataFromForm(draft),
    body: content?.value ?? draft.body,
    ...(selectedSource ? { sourceId: selectedSource } : {}),
    ...(nextCollection ? { collectionName: nextCollection } : {}),
  };
  const sourceUrlChanged = next.metadata.sourceUrl !== draft.metadata.sourceUrl;
  const selectedSourceChanged = next.sourceId !== draft.sourceId;
  const changed = sourceUrlChanged || selectedSourceChanged;
  return {
    ...next,
    ...(!sourceUrlChanged && draft.path ? { path: draft.path } : {}),
    ...(!sourceUrlChanged && draft.copyPath ? { copyPath: draft.copyPath } : {}),
    ...(draft.attempt ? { attempt: draft.attempt } : {}),
    ...(draft.duplicateVersion && !changed ? { duplicateVersion: draft.duplicateVersion } : {}),
  };
}

function queueDraft(next: Draft): Promise<void> {
  draft = next;
  draftWrite = draftWrite.then(() => saveDraft(chromeApi.storage.local, next));
  return draftWrite;
}

async function beginAttempt(current: Draft, attempt: WriteAttempt): Promise<Draft> {
  const next = { ...current, state: "saving" as const, error: undefined, attempt };
  await queueDraft(next);
  return next;
}

async function persist(): Promise<Draft | undefined> {
  const next = draftFromForm();
  if (!next) return undefined;
  await queueDraft(next);
  return next;
}

function setForm(next: Draft): void {
  if (title) title.value = next.metadata.title;
  if (sourceUrl) sourceUrl.value = next.metadata.sourceUrl;
  if (author) author.value = next.metadata.author || "";
  if (publishedAt) publishedAt.value = next.metadata.publishedAt || "";
  if (content) content.value = next.body;
  if (collection) collection.value = next.collectionName || "";
}

async function loadBundles(): Promise<void> {
  const settings = await loadSettings(chromeApi.storage.local);
  if (!settings.engineUrl || !settings.apiKey || !source) return;
  bundles = await new KnowledgeApi(settings.engineUrl, settings.apiKey).listBundles();
  source.replaceChildren();
  const newCollection = document.createElement("option");
  newCollection.value = "";
  newCollection.textContent = text.newCollection;
  source.append(newCollection);
  for (const item of bundles) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    source.append(option);
  }
  if (draft?.sourceId && bundles.some((item) => item.id === draft?.sourceId)) {
    source.value = draft.sourceId;
  }
  if (collection) collection.hidden = Boolean(source.value);
}

async function collectionSlug(name: string, current: Draft): Promise<string> {
  if (current.collectionSlug) return current.collectionSlug;
  const safe =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 72) || "clips";
  return `${safe}-${await urlHash(current.metadata.sourceUrl)}-${crypto.randomUUID().slice(0, 8)}`;
}

async function saveExisting(
  api: KnowledgeApi,
  current: Draft,
  selected: string,
  mode: "append" | "replace" | "copy",
  body: string,
): Promise<Draft> {
  if (current.attempt) {
    const attempt = current.attempt;
    if (!attempt.sourceId)
      throw new ApiError(409, "attempt_unresolved", undefined, text.attemptUncertain);
    const afterAttempt = await api.content(attempt.sourceId);
    if (attemptMatchesDocument(attempt, afterAttempt.documents)) {
      const currentBody = markdown(current.metadata, current.body);
      if (currentBody !== attempt.content || selected !== attempt.sourceId) {
        return { ...current, state: "ready", attempt: undefined, error: text.previousSaved };
      }
      return { ...current, state: "ready", attempt: undefined, path: attempt.path };
    }
    throw new ApiError(409, "attempt_unresolved", undefined, text.attemptUncertain);
  }
  const contentState = await api.content(selected);
  const originalPath = current.path || (await clipPath(current.metadata.sourceUrl));
  const path =
    mode === "copy"
      ? current.copyPath ||
        (await clipPath(current.metadata.sourceUrl, crypto.randomUUID().slice(0, 8)))
      : originalPath;
  if (mode === "copy" && !current.copyPath) {
    current = { ...current, copyPath: path };
    await queueDraft(current);
  }
  const expectedVersion = current.duplicateVersion || contentState.version;
  const attempt: WriteAttempt = {
    operation: mode,
    sourceId: selected,
    expectedVersion,
    path,
    content: body,
  };
  current = await beginAttempt(current, attempt);
  try {
    if (mode === "replace") {
      await api.replace(selected, expectedVersion, originalPath, body);
      return {
        ...current,
        state: "ready",
        attempt: undefined,
        sourceId: selected,
        path: originalPath,
      };
    }
    const appended = await api.append(selected, expectedVersion, path, body);
    return {
      ...current,
      state: "ready",
      attempt: undefined,
      sourceId: selected,
      path: appended.path,
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "version_conflict") {
      const retry = {
        ...current,
        attempt: undefined,
        duplicateVersion: undefined,
        state: "ready" as const,
        error: error.message,
      };
      await queueDraft(retry);
      draft = retry;
    }
    throw error;
  }
}

async function createOrResumeCollection(
  api: KnowledgeApi,
  current: Draft,
  body: string,
): Promise<Draft> {
  const name = current.collectionName;
  if (!name) throw new Error(text.collectionRequired);
  const path = current.path || (await clipPath(current.metadata.sourceUrl));
  const slug = persistedCollectionSlug(
    current.collectionSlug,
    current.attempt?.slug,
    await collectionSlug(name, current),
  );
  if (current.collectionSlug !== slug) {
    current = { ...current, collectionSlug: slug };
    await queueDraft(current);
  }
  if (current.attempt) {
    const known = (await api.listBundles()).find((item) => item.slug === slug);
    if (!known) throw new ApiError(409, "attempt_unresolved", undefined, text.attemptUncertain);
    const contentState = await api.content(known.id);
    if (attemptMatchesDocument(current.attempt, contentState.documents)) {
      const currentBody = markdown(current.metadata, current.body);
      if (currentBody !== current.attempt.content) {
        return { ...current, state: "ready", attempt: undefined, error: text.previousSaved };
      }
      return {
        ...current,
        state: "ready",
        attempt: undefined,
        sourceId: known.id,
        sourceName: known.name,
      };
    }
    throw new ApiError(409, "attempt_unresolved", undefined, text.attemptUncertain);
  }
  current = await beginAttempt(current, { operation: "create", path, content: body, slug });
  try {
    const created = await api.createBundle(name, slug, path, body);
    return {
      ...current,
      state: "ready",
      attempt: undefined,
      sourceId: created.knowledge_source.id,
      sourceName: name,
      path,
    };
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      error.code !== "slug_exists" ||
      !error.details?.knowledge_source_id
    ) {
      throw error;
    }
    const contentState = await api.content(error.details.knowledge_source_id);
    const attempt = current.attempt;
    if (!attempt || !attemptMatchesDocument(attempt, contentState.documents)) {
      throw new ApiError(409, "attempt_unresolved", undefined, text.attemptUncertain);
    }
    const currentBody = markdown(current.metadata, current.body);
    if (currentBody !== attempt.content) {
      return { ...current, state: "ready", attempt: undefined, error: text.previousSaved };
    }
    return {
      ...current,
      state: "ready",
      attempt: undefined,
      sourceId: error.details.knowledge_source_id,
      sourceName: name,
      path,
    };
  }
}

async function save(mode: "append" | "replace" | "copy"): Promise<void> {
  if (saving) return;
  saving = true;
  form
    ?.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("button, input, select, textarea")
    .forEach((element) => {
      element.disabled = true;
    });
  try {
    let current = await persist();
    const settings = await loadSettings(chromeApi.storage.local);
    if (!current || !settings.engineUrl || !settings.apiKey) {
      await chromeApi.runtime.openOptionsPage();
      return;
    }
    if (!isDraftForEngine(current, settings.engineUrl)) throw new Error(text.draftOtherEngine);
    const api = new KnowledgeApi(settings.engineUrl, settings.apiKey);
    const selected =
      current.attempt?.sourceId ||
      (mode === "append" ? source?.value || undefined : current.sourceId);
    const body = markdown(current.metadata, current.body);
    if (selected) {
      current = { ...current, sourceId: selected };
      await queueDraft(current);
      draft = await saveExisting(api, current, selected, mode, body);
    } else {
      draft = await createOrResumeCollection(api, current, body);
    }
    if (draft?.error === text.previousSaved) {
      await queueDraft(draft);
      if (source && draft.sourceId) source.value = draft.sourceId;
      if (collection) collection.hidden = Boolean(draft.sourceId);
      setRetryAttempt(true);
      setStatus(text.previousSaved, true);
      return;
    }
    if (draft) await queueDraft(draft);
    await clearDraft(chromeApi.storage.local);
    draft = undefined;
    setDuplicate(true);
    setRetryAttempt(true);
    setStatus(text.saved);
  } catch (error) {
    const message = error instanceof Error ? error.message : text.error;
    const confirmedConflict =
      error instanceof ApiError &&
      (error.code === "path_exists" || error.code === "version_conflict");
    if (error instanceof ApiError && error.status === 404) {
      setStatus(`${text.needsClipApi} ${text.error}`, true);
    } else if (error instanceof ApiError && error.code === "path_exists") {
      const attempt = draft?.attempt;
      if (draft && attempt) {
        draft = {
          ...draft,
          state: "ready",
          attempt: undefined,
          path: attempt.path,
          duplicateVersion: attempt.expectedVersion,
          error: message,
        };
        await queueDraft(draft);
      }
      setDuplicate(false);
      setRetryAttempt(true);
      setStatus(text.duplicate, true);
    } else if (error instanceof ApiError && error.code === "attempt_unresolved") {
      setRetryAttempt(false);
      setStatus(text.attemptUncertain, true);
    } else {
      setStatus(`${message} ${text.error}`, true);
    }
    if (draft && !confirmedConflict)
      await queueDraft({ ...draft, state: "failed", error: message });
  } finally {
    saving = false;
    form
      ?.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("button, input, select, textarea")
      .forEach((element) => {
        element.disabled = false;
      });
  }
}

async function discardAndCapture(): Promise<void> {
  try {
    setDuplicate(true);
    draft = (await chromeApi.runtime.sendMessage({
      type: "discard-and-capture",
      mode: "selection",
    })) as Draft;
    if (draft) {
      setForm(draft);
      await loadBundles();
      setStatus("");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : text.captureFailed, true);
  }
}

async function initialize(): Promise<void> {
  const settings = await loadSettings(chromeApi.storage.local);
  text = copy[language(settings.language)];
  document.documentElement.lang = language(settings.language);
  applyText(text);
  const stored = await chromeApi.storage.local.get(captureErrorKey);
  const captureError = stored[captureErrorKey] as CaptureError | undefined;
  draft = await loadDraft(chromeApi.storage.local);
  if (!draft) {
    try {
      draft = (await chromeApi.runtime.sendMessage({
        type: "start-capture",
        mode: "selection",
      })) as Draft;
    } catch (error) {
      setStatus(
        captureError?.message || (error instanceof Error ? error.message : text.captureFailed),
        true,
      );
      return;
    }
  }
  if (!settings.engineUrl || !settings.apiKey) {
    setStatus(text.needsSettings, true);
    return;
  }
  if (!isDraftForEngine(draft, settings.engineUrl)) {
    setStatus(text.draftOtherEngine, true);
    return;
  }
  setForm(draft);
  setRetryAttempt(!draft.attempt);
  try {
    await loadBundles();
    if (captureError) setStatus(captureError.message, true);
  } catch (error) {
    setStatus(`${error instanceof Error ? error.message : text.loadFailed} ${text.error}`, true);
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void save("append");
});
for (const field of [title, sourceUrl, author, publishedAt, content, collection]) {
  field?.addEventListener("input", () => {
    setDuplicate(true);
    setRetryAttempt(true);
    void persist();
  });
}
source?.addEventListener("change", () => {
  if (collection) collection.hidden = Boolean(source.value);
  setDuplicate(true);
  setRetryAttempt(true);
  void persist();
});
replace?.addEventListener("click", () => void save("replace"));
saveCopy?.addEventListener("click", () => void save("copy"));
retryAttempt?.addEventListener("click", () => {
  if (!draft) return;
  void queueDraft({ ...draft, attempt: undefined, state: "ready", error: undefined }).then(() => {
    setRetryAttempt(true);
    void save("append");
  });
});
discard?.addEventListener("click", () => {
  void clearDraft(chromeApi.storage.local).then(() => {
    draft = undefined;
    setStatus("");
  });
});
captureAgain?.addEventListener("click", () => void discardAndCapture());
setup?.addEventListener("click", () => void chromeApi.runtime.openOptionsPage());

void initialize();
