// Which conversations the dormant-title sweep is allowed to rename.
//
// The sweep runs a model over rows a person may have named by hand, so its
// selection rule is the whole safety story. That rule is a pure function and is
// tested as one. The walk around it gets two ticks and no more — enough to make
// the keyset cursor run, few enough that this suite is not paging through a
// table while its neighbours wait for a connection.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deriveConversationTitle } from "../../conversations/title.ts";
import type { Db } from "../../db/client.ts";
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

  test("a failed refresh still consumes the cap and the unfinished candidate resumes", async () => {
    await srv.db
      .delete(dataMigrations)
      .where(eq(dataMigrations.name, CONVERSATION_TITLE_SWEEP_NAME));
    const opening =
      "Erstelle einen belastbaren Abgleich für die monatlichen Lieferantenrechnungen und Abweichungen";
    const title = deriveConversationTitle({ text: opening });
    expect(title).not.toBeNull();
    for (let index = 0; index < 11; index += 1) {
      await seedConversation({
        id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        title: title as string,
        locked: false,
        opening,
      });
    }
    const refreshTitle = mock(async (_tenantId: string, _conversationId: string, _db: Db) => null);
    resetConversationTitleSweep();

    const first = await runConversationTitleSweep(srv.db, { refreshTitle });
    expect(first.retitled).toBe(0);
    expect(refreshTitle).toHaveBeenCalledTimes(10);

    await runConversationTitleSweep(srv.db, { refreshTitle });
    expect(refreshTitle).toHaveBeenCalledTimes(11);
    expect(new Set(refreshTitle.mock.calls.map((call) => call[1])).size).toBe(11);
  }, 60_000);
});

// The form that reached production: titles written before the excerpt helper
// stopped at a word boundary were cut mid-word at the same length. The first
// walk skipped every one of them and reported itself complete.
describe("isStillOpeningLine — the older clip", () => {
  const LONG =
    "Erstelle den Workflow guard-probe-replay (slug: guard-probe-replay). Ein transformierender Schritt.";
  const long = { text: LONG };

  test("a title cut mid-word at the old length is still machine-derived", () => {
    const hardClip = `${LONG.slice(0, 49)}…`;
    expect(hardClip.length).toBe(50);
    expect(isStillOpeningLine(hardClip, long)).toBe(true);
  });

  test("today's word-boundary derivation is still recognised", () => {
    expect(isStillOpeningLine(deriveConversationTitle(long), long)).toBe(true);
  });

  test("the two forms really differ, or this test proves nothing", () => {
    expect(deriveConversationTitle(long)).not.toBe(`${LONG.slice(0, 49)}…`);
  });

  test("a person's title of the same length is still left alone", () => {
    expect(isStillOpeningLine(`${"Mein eigener Titel ".repeat(3)}xyz…`, long)).toBe(false);
  });

  test("a message shorter than the limit has no clipped form to match", () => {
    expect(isStillOpeningLine("Kurz…", { text: "Kurz" })).toBe(false);
  });
});
