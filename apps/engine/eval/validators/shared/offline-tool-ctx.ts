import { createEmptyDraftDocument } from "../../../src/conversations/authoring-state.ts";
import type { ToolContext } from "../../../src/conversations/tools/index.ts";
import type { DraftDocument } from "../../../src/conversations/types.ts";
import type { Db } from "../../../src/db/client.ts";
import type { EngineClient } from "../../../src/engine-client/index.ts";

export interface OfflineToolCtx extends ToolContext {
  current: () => DraftDocument;
  dbAccesses: () => number;
}

export function makeOfflineToolCtx(
  label: string,
  initialDraft?: DraftDocument,
  overrides: Partial<ToolContext> = {},
): OfflineToolCtx {
  let draft: DraftDocument = initialDraft ?? createEmptyDraftDocument();
  let accesses = 0;
  const db = new Proxy({} as Db, {
    get(_target, property) {
      accesses += 1;
      throw new Error(`offline scenario ${label} touched the database (${String(property)})`);
    },
  });
  const engineClient = new Proxy({} as EngineClient, {
    get(_target, property) {
      accesses += 1;
      throw new Error(`offline scenario ${label} touched the engine client (${String(property)})`);
    },
  });
  return {
    db,
    tenant_id: "00000000-0000-4000-8000-0000000e0a11",
    conversation_id: "00000000-0000-4000-8000-00000000c0de",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    permission_mode: "auto",
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    ...overrides,
    current: () => draft,
    dbAccesses: () => accesses,
  };
}
