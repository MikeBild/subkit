import { createHash } from "node:crypto";
import type { DiscoveredConnectorEndpoints } from "./endpoint-grounding.ts";
import { workflowDefinitionFingerprint } from "./preview-judge.ts";
import { canonicalJson } from "./text-line-diff.ts";

function sha16(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

export function groundingFingerprint(
  groundingIndex: ReadonlyMap<string, DiscoveredConnectorEndpoints>,
  docsByConnector?: ReadonlyMap<string, string>,
): string | null {
  try {
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

export interface ConfirmIntent {
  kind?: string;
  commit_intent?: unknown;
  target?: unknown;
}

export function intentHasDistinguishingAction(confirm: ConfirmIntent): boolean {
  return confirm.commit_intent !== undefined || confirm.target !== undefined;
}

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
