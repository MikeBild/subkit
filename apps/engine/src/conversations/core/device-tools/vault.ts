import {
  type BrowserVaultResult,
  BrowserVaultResultSchema,
  PAY_FIELD_NAMES,
  type PayFieldName,
  payPageFingerprintText,
} from "@shared/device/browser.ts";
import { redactKnownValues, scrubStringsDeep } from "@shared/redaction.ts";
import { untrustedPayload } from "@shared/untrusted-content.ts";
import { normalizeOrigin } from "@shared/vault-validate.ts";
import type { DeviceStep } from "../../instruction-cover/job.ts";
import type { DeviceStepRecord } from "./history.ts";
import { type DeviceToolFailure, stoppedOutput } from "./result.ts";
import {
  browserRefKey,
  type ElementFacts,
  parseBrowserSnapshot,
  refFreshness,
} from "./snapshot.ts";

type Input = Record<string, unknown>;

export type SignInField = "username" | "password" | "code" | "submit";
export const SIGN_IN_FIELDS: readonly SignInField[] = ["username", "password", "code", "submit"];

export interface VaultPage {
  readonly origin: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly elements: Readonly<Record<string, ElementFacts>>;
}

function refInput(input: Input, field: string): string | null {
  const value = input[`${field}_ref`];
  return typeof value === "string" ? browserRefKey(value) : null;
}

export function namedRefs(tool: string, input: Input): Record<string, string> {
  const fields: readonly string[] = tool === "browser_pay" ? PAY_FIELD_NAMES : SIGN_IN_FIELDS;
  return Object.fromEntries(
    fields.flatMap((field) => {
      const ref = refInput(input, field);
      return ref === null ? [] : [[field, ref]];
    }),
  );
}

export function vaultPage(
  tool: string,
  input: Input,
  steps: readonly DeviceStepRecord[],
): VaultPage | DeviceToolFailure {
  const latest = steps[0] ?? null;
  const requested = typeof input.snapshot_id === "string" ? input.snapshot_id : null;
  const freshness = refFreshness(latest, "browser_snapshot", requested);
  if (!freshness.fresh) return stoppedOutput(freshness.reason);
  const page = freshness.snapshot;
  const origin = normalizeOrigin(String(page.origin ?? ""));
  const claimed = normalizeOrigin(String(input.origin ?? ""));
  if (origin === null) return stoppedOutput("origin_not_secure");
  if (claimed !== origin) return stoppedOutput("origin_mismatch", origin);
  const refs = namedRefs(tool, input);
  if (Object.keys(refs).length === 0) return stoppedOutput("unknown_ref");
  const elements: Record<string, ElementFacts> = {};
  for (const ref of Object.values(refs)) {
    const element = page.refs?.[ref];
    if (!element) return stoppedOutput("unknown_ref", ref);
    elements[ref] = element;
  }
  return { origin, refs, elements };
}

export function sameElements(
  expected: Readonly<Record<string, ElementFacts>>,
  output: unknown,
): boolean {
  const page = parseBrowserSnapshot(output);
  return Object.entries(expected).every(([ref, element]) => {
    const now = page.refs[ref];
    return now !== undefined && now.role === element.role && now.name === element.name;
  });
}

export function payPageFingerprintSource(page: VaultPage): string {
  const facts: Partial<Record<PayFieldName, { role: string | null; name: string | null }>> = {};
  for (const field of PAY_FIELD_NAMES) {
    const ref = page.refs[field];
    const element = ref === undefined ? undefined : page.elements[ref];
    if (element) facts[field] = { role: element.role, name: element.name };
  }
  return payPageFingerprintText(page.origin, facts);
}

export function payFieldFrames(page: VaultPage): Record<string, string> {
  return Object.fromEntries(Object.keys(page.refs).map((field) => [field, page.origin]));
}

export function vaultDeviceStep(p: {
  readonly tool: string;
  readonly job_id: string;
  readonly origin: string;
  readonly quote: string | null;
}): DeviceStep {
  const paying = p.tool === "browser_pay";
  return {
    kind: "device",
    job_id: p.job_id,
    capability: "browser",
    phase: "commit",
    always_ask: paying ? "payment" : null,
    name: paying ? "pay" : "sign in",
    target: p.origin,
    url: p.origin,
    values: [],
    quote: p.quote,
  };
}

export function formatAmount(amount_minor: number, currency: string, locale: "de" | "en"): string {
  return new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    style: "currency",
    currency,
  }).format(amount_minor / 100);
}

export interface VaultToolData extends Record<string, unknown> {
  readonly filled: boolean;
  readonly submitted: boolean;
  readonly outcome: BrowserVaultResult["outcome"] | "failed";
  readonly note: string;
}

export function vaultResultOf(output: unknown): BrowserVaultResult | null {
  const parsed = BrowserVaultResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

export function vaultToolData(
  result: BrowserVaultResult,
  note: string,
  known: readonly string[],
): VaultToolData {
  const snapshot =
    result.snapshot === undefined
      ? {}
      : {
          snapshot: untrustedPayload(
            "page",
            redactKnownValues(scrubStringsDeep(parseBrowserSnapshot(result.snapshot).text), known),
          ),
        };
  return {
    filled: result.filled,
    submitted: result.submitted,
    outcome: result.outcome,
    note,
    ...(result.reason ? { reason: result.reason } : {}),
    ...snapshot,
  };
}

interface PendingVaultBase {
  readonly origin: string;
  readonly item_id: string;
  readonly elements: Readonly<Record<string, ElementFacts>>;
  readonly actor_id: string;
  readonly conversation_id: string;
  readonly run_id: string | null;
  readonly task_id: string | null;
}

export type PendingVaultUse =
  | (PendingVaultBase & {
      readonly purpose: "sign_in";
      readonly value_digest: string;
      readonly kind: "password" | "totp";
      readonly fields: Readonly<Partial<Record<SignInField, string>>>;
    })
  | (PendingVaultBase & { readonly purpose: "pay"; readonly payment_id: string });
