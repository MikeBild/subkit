export interface ElementFacts {
  readonly role: string | null;
  readonly name: string | null;
  readonly href?: string | null;
}

export interface PageSnapshot {
  readonly origin: string | null;
  readonly text: string;
  readonly refs: Readonly<Record<string, ElementFacts>>;
}

export interface WindowSnapshot {
  readonly snapshot_id: string;
  readonly window_id: string;
  readonly state_hash: string | null;
  readonly app: string | null;
  readonly tree: unknown;
  readonly refs: Readonly<Record<string, ElementFacts>>;
}

type Bag = Record<string, unknown>;

export function bag(value: unknown): Bag {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const REF_LINE = /^(\s*)-\s*([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*[[ ,]ref=(e[0-9]+)[\],]/u;
const URL_LINE = /^(\s*)-\s*\/url:\s*(\S+)\s*$/u;

export function browserRefKey(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

function refsFromText(text: string): Record<string, ElementFacts> {
  const refs: Record<string, ElementFacts> = {};
  let last: { ref: string; indent: number } | null = null;
  for (const line of text.split("\n")) {
    const found = REF_LINE.exec(line);
    if (found) {
      const ref = found[4] as string;
      refs[ref] = { role: found[2] as string, name: str(found[3]), href: null };
      last = { ref, indent: (found[1] as string).length };
      continue;
    }
    const url = URL_LINE.exec(line);
    if (url && last && (url[1] as string).length > last.indent)
      refs[last.ref] = { ...(refs[last.ref] as ElementFacts), href: url[2] as string };
  }
  return refs;
}

export function parseBrowserSnapshot(output: unknown): PageSnapshot {
  const top = bag(output);
  const data = typeof top.snapshot === "string" ? { snapshot: top.snapshot } : bag(top.snapshot);
  const text = typeof data.snapshot === "string" ? data.snapshot : "";
  const refs = refsFromText(text);
  for (const [key, value] of Object.entries(bag(data.refs))) {
    const facts = bag(value);
    const known = refs[browserRefKey(key)];
    refs[browserRefKey(key)] = {
      role: str(facts.role) ?? known?.role ?? null,
      name: str(facts.name) ?? known?.name ?? null,
      href: str(facts.href) ?? str(facts.url) ?? known?.href ?? null,
    };
  }
  return { origin: str(bag(top.step).origin), text, refs };
}

function collect(node: unknown, into: Record<string, ElementFacts>, depth: number): void {
  if (depth > 200) return;
  const current = bag(node);
  const ref = str(current.ref);
  if (ref !== null) into[ref] = { role: str(current.role), name: str(current.name) };
  const children = current.children;
  if (Array.isArray(children)) for (const child of children) collect(child, into, depth + 1);
}

export function parseWindowSnapshot(output: unknown): WindowSnapshot | null {
  const top = bag(output);
  const snapshot_id = str(top.snapshot_id);
  const window_id = str(bag(top.window).id);
  if (snapshot_id === null || window_id === null) return null;
  const refs: Record<string, ElementFacts> = {};
  collect(top.tree, refs, 0);
  return {
    snapshot_id,
    window_id,
    state_hash: str(top.state_hash),
    app: str(top.app),
    tree: top.tree ?? null,
    refs,
  };
}

export function computerRefSnapshot(ref: string): string | null {
  const match = /^@s([a-z0-9]+):e[0-9]+$/u.exec(ref);
  return match ? (match[1] as string) : null;
}

export interface LatestDeviceCall {
  readonly tool: string;
  readonly snapshot_id: string | null;
}

export type Freshness<T extends LatestDeviceCall> =
  | { readonly fresh: true; readonly snapshot: T }
  | { readonly fresh: false; readonly reason: "no_snapshot" | "snapshot_used" | "other_snapshot" };

export function refFreshness<T extends LatestDeviceCall>(
  latest: T | null,
  snapshot_tool: "browser_snapshot" | "computer_snapshot",
  requested: string | null,
): Freshness<T> {
  if (latest === null) return { fresh: false, reason: "no_snapshot" };
  if (latest.tool !== snapshot_tool) return { fresh: false, reason: "snapshot_used" };
  if (requested !== latest.snapshot_id) return { fresh: false, reason: "other_snapshot" };
  return { fresh: true, snapshot: latest };
}
