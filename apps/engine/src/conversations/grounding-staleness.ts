// Grounding-staleness check for the `/context` advisory.
//
// A workflow draft records the fingerprint of the grounding it was built on
// (`AuthoringState.grounding_fingerprint`). At resume we recompute the
// CURRENT fingerprint for the draft's connectors and compare: if the
// connector schema changed since the draft was generated, `/context` shows
// a friendly "re-check before saving" advisory. Advisory only — it never
// blocks, and every read error falls toward silence (`unknown`), never a
// false `stale`.

import { readDiscoveryIndexForConnector } from "../connectors/discovery/service.ts";
import { getConnector } from "../connectors/service.ts";
import type { Executor } from "../db/client.ts";
import { buildGroundingIndex } from "./endpoint-grounding.ts";
import { groundingFingerprint } from "./intent-fingerprint.ts";
import type { DraftDocument } from "./types.ts";

export interface GroundingStatus {
  state: "fresh" | "stale" | "unknown";
  advisory: string | null;
}

const STALE_ADVISORY =
  "This draft was built on a connector schema that has changed since the last checkpoint — re-check before saving.";

/** Recompute the current grounding fingerprint for a set of connectors,
 *  using the SAME projection the authoring pipeline grounded on. Returns
 *  null when nothing is discoverable (no advisory possible). */
async function computeCurrentGroundingFingerprint(
  tenant_id: string,
  connectorIds: readonly string[],
  db: Executor,
): Promise<string | null> {
  const connectors: Array<{ id: string; slug: string; base_url: string | null }> = [];
  const discoveredById = new Map<
    string,
    {
      endpoints: ReadonlyArray<{
        method: string;
        path: string;
        request_content_type: string | null;
      }>;
    }
  >();
  for (const id of connectorIds) {
    const c = await getConnector(tenant_id, id, db);
    if (!c) continue;
    connectors.push({ id: c.id, slug: c.slug, base_url: c.base_url });
    const index = await readDiscoveryIndexForConnector(db, tenant_id, {
      base_url: c.base_url,
      self_description: c.self_description,
    });
    if (index && index.endpoints.length > 0) discoveredById.set(id, index);
  }
  return groundingFingerprint(buildGroundingIndex(connectors, discoveredById));
}

/**
 * Compute the `/context` grounding_status for a draft. Returns null when
 * the draft carries no grounding fingerprint (nothing to compare). Fresh
 * when the connector schema is unchanged, stale (with advisory) when it
 * changed, unknown when the fingerprint can't be recomputed.
 */
export async function computeGroundingStatus(
  tenant_id: string,
  draft: DraftDocument | null | undefined,
  db: Executor,
): Promise<GroundingStatus | null> {
  const storedFp = draft?.state?.grounding_fingerprint;
  if (!storedFp) return null;

  // The connector set the fingerprint was computed over rides on
  // AuthoringState (the workflow draft's normalize allowlist would drop it).
  const connectorIds = draft?.state?.grounding_connector_ids;
  if (!Array.isArray(connectorIds) || connectorIds.length === 0) {
    return { state: "unknown", advisory: null };
  }

  try {
    const currentFp = await computeCurrentGroundingFingerprint(
      tenant_id,
      connectorIds.filter((id): id is string => typeof id === "string"),
      db,
    );
    if (currentFp === null) return { state: "unknown", advisory: null };
    return currentFp === storedFp
      ? { state: "fresh", advisory: null }
      : { state: "stale", advisory: STALE_ADVISORY };
  } catch {
    // Fail toward silence — a recompute error must never manufacture a
    // false staleness warning.
    return { state: "unknown", advisory: null };
  }
}
