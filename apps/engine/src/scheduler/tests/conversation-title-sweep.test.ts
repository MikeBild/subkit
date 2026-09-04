// Which conversations the dormant-title sweep is allowed to rename.
//
// The sweep runs a model over rows a person may have named by hand, so its
// selection rule is the whole safety story. That rule is a pure function and is
// tested as one. The walk around it gets two ticks and no more — enough to make
// the keyset cursor run, few enough that this suite is not paging through a
// table while its neighbours wait for a connection.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deriveConversationTitle } from "../../conversations/title.ts";
import { conversationMessages, conversations, dataMigrations } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import {
  CONVERSATION_TITLE_SWEEP_NAME,
  isStillOpeningLine,
  resetConversationTitleSweep,
  runConversationTitleSweep,
} from "../conversation-title-runner.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("conversation-title-sweep");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

async function seedConversation(input: {
  id: string;
  title: string;
  locked: boolean;
  opening: string;
}): Promise<void> {
  await srv.db.insert(conversations).values({
    id: input.id,
    tenant_id: srv.tenantId,
    status: "active",
    title: input.title,
    title_locked: input.locked,
  });
  await srv.db.insert(conversationMessages).values({
    tenant_id: srv.tenantId,
    conversation_id: input.id,
    role: "user",
    content: { text: input.opening },
  });
}

const OPENING = "Bearbeite den bestehenden Workflow-Draft und prüfe die Schritte auf Fehler";
const message = { text: OPENING };

describe("isStillOpeningLine", () => {
  test("a title that is still the derived opening line may be rewritten", () => {
    const derived = deriveConversationTitle(message);
    expect(derived).not.toBeNull();
    expect(isStillOpeningLine(derived, message)).toBe(true);
  });

  test("a title the model already wrote is left alone", () => {
    expect(isStillOpeningLine("Workflow-Draft prüfen und reparieren", message)).toBe(false);
  });

  test("a title a person typed is left alone even when it starts the same way", () => {
    const derived = deriveConversationTitle(message) as string;
    expect(isStillOpeningLine(`${derived} (Q3)`, message)).toBe(false);
  });

  test("a conversation without a readable opening message is never a candidate", () => {
    expect(isStillOpeningLine("Irgendein Titel", undefined)).toBe(false);
    expect(isStillOpeningLine("Irgendein Titel", { text: "" })).toBe(false);
  });

  test("a row with no title at all is the backfill's business, not the sweep's", () => {
    expect(isStillOpeningLine(null, message)).toBe(false);
  });
});

// The walk itself, twice, so the keyset branch actually runs.
//
// The first tick returns every seeded row and leaves a cursor; the second has
// to use that cursor, which is where the composite `(updated_at, id) <` lives.
// A malformed predicate fails here rather than silently on an installation.
describe("runConversationTitleSweep — the walk", () => {
  test("a second tick resumes past the first and finishes the walk", async () => {
    await srv.db
      .delete(dataMigrations)
      .where(eq(dataMigrations.name, CONVERSATION_TITLE_SWEEP_NAME));
    await seedConversation({
      id: "44444444-4444-4444-8444-444444444444",
      title: "Erster",
      locked: false,
      opening: OPENING,
    });
    await seedConversation({
      id: "55555555-5555-4555-8555-555555555555",
      title: "Zweiter",
      locked: false,
      opening: OPENING,
    });
    resetConversationTitleSweep();

    const first = await runConversationTitleSweep(srv.db);
    expect(first.done).toBe(false);
    expect(first.scanned).toBeGreaterThan(0);

    const second = await runConversationTitleSweep(srv.db);
    expect(second.done).toBe(true);
  }, 60_000);
});
