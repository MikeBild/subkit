import {
  type BrowserPayArgs,
  type BrowserSignInArgs,
  type BrowserVaultResult,
  payPageFingerprintText,
  type VaultFillOutcome,
} from "@shared/device/browser.ts";
import { totpCode, totpSeedFrom } from "@shared/totp.ts";
import { sha256Hex } from "../../shared/local/browser-rules.ts";
import type { AgentBrowserResult } from "./agent-browser.ts";
import {
  checkVisibleTotal,
  DOCUMENT_PROBE_SCRIPT,
  documentId,
  FRAME_PROBE_SCRIPT,
  type FrameProbe,
  frameProbe,
  type RefFacts,
  redactFilled,
  sameOrigin,
  TOTAL_PROBE_SCRIPT,
} from "./vault-fill.ts";

export interface SecretTickets {
  claim(ticket: string, signal: AbortSignal): Promise<Map<string, string> | null>;
}

export const NO_TICKETS: SecretTickets = { claim: async () => null };

export type VaultRequest =
  | { readonly kind: "browser.sign_in"; readonly args: BrowserSignInArgs }
  | { readonly kind: "browser.pay"; readonly args: BrowserPayArgs };

export type VaultResult = Omit<BrowserVaultResult, "step">;

export interface RecordedSnapshot {
  readonly document: string;
  readonly facts: Readonly<Record<string, RefFacts>>;
}

export interface VaultPage {
  call(tool: string, input: Record<string, unknown>): Promise<unknown>;
  attempt(tool: string, input: Record<string, unknown>): Promise<AgentBrowserResult>;
  origin(): Promise<string | null>;
  scripted(): boolean;
  recorded(): RecordedSnapshot | null;
}

export interface VaultProgress {
  filled: boolean;
  submitting: boolean;
}

interface Target {
  readonly name: string;
  readonly ref: string;
  readonly frame: string;
}

const SIGN_IN_ORDER = ["username", "password", "code"] as const;
const PAY_ORDER = ["number", "exp", "exp_month", "exp_year", "holder", "cvv"] as const;

class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

function selector(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

function targetsOf(request: VaultRequest): { fields: Target[]; submit: Target | null } {
  const { args } = request;
  if (request.kind === "browser.sign_in") {
    const fields = request.args.fields;
    return {
      fields: SIGN_IN_ORDER.flatMap((name) => {
        const ref = fields[name];
        return ref ? [{ name, ref, frame: args.origin }] : [];
      }),
      submit: fields.submit ? { name: "submit", ref: fields.submit, frame: args.origin } : null,
    };
  }
  const { fields, field_frames } = request.args;
  const frameOf = (name: (typeof PAY_ORDER)[number] | "submit") =>
    field_frames[name] ?? args.origin;
  return {
    fields: PAY_ORDER.flatMap((name) => {
      const ref = fields[name];
      return ref ? [{ name, ref, frame: frameOf(name) }] : [];
    }),
    submit: { name: "submit", ref: fields.submit, frame: frameOf("submit") },
  };
}

async function probe(page: VaultPage, target: Target, field: boolean): Promise<FrameProbe> {
  await page.call("agent_browser_focus", { selector: selector(target.ref) });
  const found = frameProbe(await page.call("agent_browser_eval", { script: FRAME_PROBE_SCRIPT }));
  if (found === null || found.origin === null) refuse("frame_unknown");
  if (!sameOrigin(found.origin, target.frame)) refuse("frame_origin_mismatch");
  if (field && !found.cross_origin && !["INPUT", "TEXTAREA", "SELECT"].includes(found.tag ?? ""))
    refuse("not_a_field");
  return found;
}

export function payFingerprint(
  args: BrowserPayArgs,
  facts: Readonly<Record<string, RefFacts>>,
): string {
  const named = Object.fromEntries(
    Object.entries(args.fields).flatMap(([name, ref]) => {
      const found = ref ? facts[ref.startsWith("@") ? ref.slice(1) : ref] : undefined;
      return found ? [[name, found]] : [];
    }),
  );
  return sha256Hex(payPageFingerprintText(args.origin, named));
}

async function checkPage(page: VaultPage, request: VaultRequest): Promise<void> {
  if (!sameOrigin(await page.origin(), request.args.origin)) refuse("origin_mismatch");
  if (page.scripted()) refuse("script_ran");
  const recorded = page.recorded();
  if (recorded === null) refuse("no_snapshot");
  const current = documentId(
    await page.call("agent_browser_eval", { script: DOCUMENT_PROBE_SCRIPT }),
  );
  if (current === null) refuse("document_unknown");
  if (current !== recorded.document) refuse("document_changed");
  if (request.kind !== "browser.pay") return;
  if (payFingerprint(request.args, recorded.facts) !== request.args.page_fingerprint)
    refuse("fingerprint_changed");
  const total = checkVisibleTotal(
    await page.call("agent_browser_eval", { script: TOTAL_PROBE_SCRIPT }),
    request.args.amount_minor,
    request.args.currency,
  );
  if (total === "mismatch") refuse("amount_mismatch");
}

function two(value: string): string {
  return value.padStart(2, "0").slice(-2);
}

function valuesFor(
  request: VaultRequest,
  secrets: Map<string, string>,
  known: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const need = (key: string) => {
    const value = secrets.get(key);
    if (value === undefined || value === "") refuse("value_missing");
    known.push(value);
    return value;
  };
  for (const { name } of targetsOf(request).fields) {
    if (name === "code") {
      const seed = totpSeedFrom(need("totp_seed"));
      if (seed === null) refuse("value_missing");
      const code = totpCode(seed, Date.now());
      known.push(code);
      out.set(name, [code]);
    } else if (name === "exp") {
      out.set(name, [`${two(need("exp_month"))}/${two(need("exp_year"))}`]);
    } else if (name === "exp_month") {
      const month = need("exp_month");
      out.set(name, [two(month), String(Number(month))]);
    } else if (name === "exp_year") {
      const year = need("exp_year");
      const full = year.length === 2 ? `20${year}` : year;
      out.set(name, [full, two(full)]);
    } else out.set(name, [need(name)]);
  }
  return out;
}

async function fillOne(
  page: VaultPage,
  target: Target,
  found: FrameProbe,
  candidates: readonly string[],
): Promise<void> {
  const at = selector(target.ref);
  if (found.tag === "SELECT") {
    for (const value of candidates) {
      const result = await page.attempt("agent_browser_select", { selector: at, values: [value] });
      if (result.ok) return;
    }
    refuse("fill_failed");
  }
  let text = candidates[0] ?? "";
  if (target.name === "exp_year") {
    const limit = await page.attempt("agent_browser_get_attr", { selector: at, name: "maxlength" });
    const max = limit.ok ? Number((limit.data as { value?: unknown } | null)?.value) : Number.NaN;
    if (max === 2) text = candidates[1] ?? text;
  }
  const result = await page.attempt("agent_browser_fill", { selector: at, text });
  if (!result.ok) refuse("fill_failed");
}

export async function runVaultAction(
  request: VaultRequest,
  page: VaultPage,
  tickets: SecretTickets,
  claimed: Set<string>,
  signal: AbortSignal,
  progress: VaultProgress,
): Promise<VaultResult> {
  const known: string[] = [];
  let secrets: Map<string, string> | null = null;
  const result = (outcome: VaultFillOutcome, extra: Partial<VaultResult> = {}): VaultResult => ({
    filled: progress.filled,
    submitted: progress.submitting,
    outcome,
    ...extra,
  });
  try {
    const { fields, submit } = targetsOf(request);
    if (fields.length === 0) refuse("no_fields");
    await checkPage(page, request);
    for (const target of fields) await probe(page, target, true);
    if (submit) await probe(page, submit, false);
    if (claimed.has(request.args.secret_ticket)) refuse("ticket_used");
    claimed.add(request.args.secret_ticket);
    secrets = await tickets.claim(request.args.secret_ticket, signal);
    if (secrets === null) refuse("ticket_unavailable");
    const values = valuesFor(request, secrets, known);
    for (const target of fields) {
      const found = await probe(page, target, true);
      progress.filled = true;
      await fillOne(page, target, found, values.get(target.name) ?? []);
    }
    values.clear();
    if (submit) {
      await probe(page, submit, false);
      progress.submitting = true;
      const pressed = await page.attempt("agent_browser_click", { selector: selector(submit.ref) });
      if (!pressed.ok) return result("uncertain", { reason: "submit_unconfirmed" });
    } else {
      progress.submitting = true;
      const pressed = await page.attempt("agent_browser_press", { key: "Enter" });
      if (!pressed.ok) return result("uncertain", { reason: "submit_unconfirmed" });
    }
    await page.attempt("agent_browser_wait_for_load", { state: "load" });
    const snapshot = await page.attempt("agent_browser_snapshot", { interactive: true });
    return result("submitted", snapshot.ok ? { snapshot: redactFilled(snapshot.data, known) } : {});
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return result("refused", { reason: error.reason });
  } finally {
    secrets?.clear();
    known.fill("");
    known.length = 0;
  }
}
