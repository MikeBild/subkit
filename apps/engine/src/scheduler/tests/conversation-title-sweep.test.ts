// Which conversations the dormant-title sweep is allowed to rename.
//
// The sweep runs a model over rows a person may have named by hand, so its
// selection rule is the whole safety story. That rule is a pure function and
// is tested as one here: the sweep itself walks every tenant on the instance,
// and a test that invokes it against the shared test database competes with
// every other suite in the process for connections.

import { describe, expect, test } from "bun:test";
import { deriveConversationTitle } from "../../conversations/title.ts";
import { isStillOpeningLine } from "../conversation-title-runner.ts";

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
