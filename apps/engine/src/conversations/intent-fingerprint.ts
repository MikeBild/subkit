// Shared draft-intent fingerprints — the identity primitive for the
// grounding-staleness advisory and the declined-intent guard. Both need "a
// stable fingerprint of an authoring draft/intent"; both key on fingerprints
// that already exist (`workflowDefinitionFingerprint`, and the
// discovered-endpoint grounding projection the pipeline already builds).
//
// Pure + deterministic (the determinism gate covers this file). Every
// helper is FAIL-OPEN: it returns `null` on any error, and callers treat
// `null` as "no fingerprint" — the advisory stays silent, the declined-intent
// guard falls through to a normal prompt. A fingerprint never fabricates a
// block.

import { createHash } from "node:crypto";
import type { DiscoveredConnectorEndpoints } from "./endpoint-grounding.ts";
import { workflowDefinitionFingerprint } from "./preview-judge.ts";
import { canonicalJson } from "./text-line-diff.ts";

function sha16(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

/**
 * Fingerprint of the grounding a draft was built on: the discovered
 * connector endpoints (method + path + content-type), plus optional
 * per-connector documentation content hashes. Hashes the NORMALIZED,
 * sorted projection only — never the raw spec — so a benign re-discovery
 * (reordered endpoints) does not read as a change. Returns `null` when the
 * index is empty (nothing to anchor) or on any error.
 */
export function groundingFingerprint(
  groundingIndex: ReadonlyMap<string, DiscoveredConnectorEndpoints>,
  docsByConnector?: ReadonlyMap<string, string>,
): string | null {
  try {
    // The index carries both id→proj and slug→proj entries for the same
    // connector; dedup by slug so each connector counts once.
    const bySlug = new Map<string, DiscoveredConnectorEndpoints>();
    for (const proj of groundingIndex.values()) bySlug.set(proj.slug, proj);
    if (bySlug.size === 0) return null;

    const endpoints = [...bySlug.values()]
      .map((proj) => ({
        slug: proj.slug,
        endpoints: [...proj.endpoints]
          .map((e) => ({ method: e.method, path: e.path, content_type: e.request_content_type }))
          .sort((a, b) =>
            `${a.method} ${a.path} ${a.content_type}`.localeCompare(
              `${b.method} ${b.path} ${b.content_type}`,
            ),
          ),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));

    const docs = docsByConnector
      ? [...docsByConnector.entries()]
          .map(([slug, hash]) => ({ slug, hash }))
          .sort((a, b) => a.slug.localeCompare(b.slug))
      : [];

    return sha16({ endpoints, docs });
  } catch {
    return null;
  }
}

/** The confirm elicitation an intent fingerprint is derived from. */
export interface ConfirmIntent {
  kind?: string;
  commit_intent?: unknown;
  target?: unknown;
}

/**
 * True when a confirm carries a concrete action — a `commit_intent` (the
 * write the harness would apply) or an explicit `target`. Only these have a
 * stable identity worth remembering: the declined-intent guard keys on it.
 * A bare confirmation is just a question whose identity would be only
 * `kind` + draft, which two unrelated questions share — guarding those would
 * block a DIFFERENT question after one was declined. Recorder and guard both
 * gate on this so they never disagree on what counts as "the same ask".
 */
export function intentHasDistinguishingAction(confirm: ConfirmIntent): boolean {
  return confirm.commit_intent !== undefined || confirm.target !== undefined;
}

/**
 * Fingerprint of an authoring INTENT — the identity the declined-intent
 * guard keys on to recognise "the same proposal". Combines the confirm
 * kind + commit-intent
 * with the draft's own identity (the workflow definition fingerprint when a
 * workflow draft is present). Two confirms with the same fingerprint are
 * the same ask; an edited draft yields a different one. Returns `null` on
 * any error (guard then falls open — never suppresses a genuine prompt).
 */
export function authoringIntentFingerprint(
  confirm: ConfirmIntent,
  draft: { workflow?: unknown } | null | undefined,
): string | null {
  try {
    const workflow_fp =
      draft?.workflow != null ? workflowDefinitionFingerprint(draft.workflow) : null;
    return sha16({
      kind: confirm.kind ?? null,
      commit_intent: confirm.commit_intent ?? null,
      target: confirm.target ?? null,
      workflow_fp,
    });
  } catch {
    return null;
  }
}
