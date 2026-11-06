import { readDiscoveryIndexForConnector } from "../connectors/discovery/service.ts";
import { getConnector } from "../connectors/service.ts";
import type { Executor } from "../db/client.ts";
import { buildGroundingIndex } from "./endpoint-grounding.ts";
import { groundingFingerprint } from "./intent-fingerprint.ts";
import type { DraftDocument } from "./types.ts";

interface GroundingStatus {
  state: "fresh" | "stale" | "unknown";
  advisory: string | null;
}

const STALE_ADVISORY =
  "This draft was built on a connector schema that has changed since the last checkpoint — re-check before saving.";

async function computeCurrentGroundingFingerprint(
  tenant_id: string,
  connectorIds: readonly string[],
  db: Executor,
): Promise<{ fingerprint: string | null; complete: boolean }> {
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
  let complete = true;
  for (const id of connectorIds) {
    const c = await getConnector(tenant_id, id, db);
    if (!c) {
      complete = false;
      continue;
    }
    connectors.push({ id: c.id, slug: c.slug, base_url: c.base_url });
    const index = await readDiscoveryIndexForConnector(db, tenant_id, {
      base_url: c.base_url,
      self_description: c.self_description,
    });
    if (index && index.endpoints.length > 0) discoveredById.set(id, index);
    else complete = false;
  }
  return {
    fingerprint: groundingFingerprint(buildGroundingIndex(connectors, discoveredById)),
    complete,
  };
}

export async function computeGroundingStatus(
  tenant_id: string,
  draft: DraftDocument | null | undefined,
  db: Executor,
): Promise<GroundingStatus | null> {
  const storedFp = draft?.state?.grounding_fingerprint;
  if (!storedFp) return null;

  const connectorIds = draft?.state?.grounding_connector_ids;
  if (!Array.isArray(connectorIds) || connectorIds.length === 0) {
    return { state: "unknown", advisory: null };
  }

  try {
    const { fingerprint: currentFp, complete } = await computeCurrentGroundingFingerprint(
      tenant_id,
      connectorIds.filter((id): id is string => typeof id === "string"),
      db,
    );
    if (currentFp === null) return { state: "unknown", advisory: null };
    if (currentFp === storedFp) return { state: "fresh", advisory: null };
    return complete
      ? { state: "stale", advisory: STALE_ADVISORY }
      : { state: "unknown", advisory: null };
  } catch {
    return { state: "unknown", advisory: null };
  }
}
