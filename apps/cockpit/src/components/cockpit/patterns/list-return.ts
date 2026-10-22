export interface ListReturn {
  search: string;
  scrollTop: number;
  openedId: string | null;
  at: number;
}

export interface ListReturnStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LIST_RETURN_MAX_AGE_MS = 30 * 60 * 1000;
export const RETURNED_ROW_MS = 2000;

function key(listPath: string): string {
  return `sk.list-return:${listPath}`;
}

function sessionStore(): ListReturnStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberListReturn(
  listPath: string,
  entry: Omit<ListReturn, "at">,
  now: number = Date.now(),
  store: ListReturnStore | null = sessionStore(),
): void {
  if (!store) return;
  try {
    store.setItem(key(listPath), JSON.stringify({ ...entry, at: now }));
  } catch {}
}

function valid(value: unknown): value is ListReturn {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.search === "string" &&
    (entry.search === "" || entry.search.startsWith("?")) &&
    typeof entry.scrollTop === "number" &&
    Number.isFinite(entry.scrollTop) &&
    (entry.openedId === null || typeof entry.openedId === "string") &&
    typeof entry.at === "number"
  );
}

export function readListReturn(
  listPath: string,
  now: number = Date.now(),
  store: ListReturnStore | null = sessionStore(),
): ListReturn | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key(listPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed) || now - parsed.at > LIST_RETURN_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function settleListReturn(
  listPath: string,
  store: ListReturnStore | null = sessionStore(),
  now: number = Date.now(),
): void {
  const entry = readListReturn(listPath, now, store);
  if (!entry || !store) return;
  try {
    store.setItem(key(listPath), JSON.stringify({ ...entry, openedId: null }));
  } catch {}
}

export function listReturnHref(listPath: string, entry: ListReturn | null): string {
  return entry?.search ? `${listPath}${entry.search}` : listPath;
}
