import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  CONVERSATION_REFERENCE_TYPES,
  isConversationReferenceType,
} from "./conversation-reference.ts";
import { SUGGEST_NEXT_KINDS, SUGGEST_NEXT_REASONS } from "./suggest-next-reasons.ts";

test("conversation references expose the exact cross-surface discriminants", () => {
  const supported = [
    "workflow",
    "connector",
    "skill",
    "knowledge_source",
    "execution",
    "intake_item",
  ];
  expect([...CONVERSATION_REFERENCE_TYPES] as string[]).toEqual(supported);
  for (const value of supported) expect(isConversationReferenceType(value)).toBe(true);
  for (const value of [null, undefined, true, 1, {}, [], "", "Workflow", "workflow "])
    expect(isConversationReferenceType(value)).toBe(false);
  fc.assert(
    fc.property(fc.string(), (value) =>
      expect(isConversationReferenceType(value)).toBe(supported.includes(value)),
    ),
    { seed: 20261109, numRuns: 100 },
  );
});

test("the type predicate still rejects non-strings after a JavaScript consumer mutates its export", () => {
  const original = [...CONVERSATION_REFERENCE_TYPES];
  try {
    Reflect.apply(Array.prototype.push, CONVERSATION_REFERENCE_TYPES, [1]);
    expect(isConversationReferenceType(1)).toBe(false);
  } finally {
    Reflect.apply(Array.prototype.splice, CONVERSATION_REFERENCE_TYPES, [
      0,
      CONVERSATION_REFERENCE_TYPES.length,
      ...original,
    ]);
  }
  expect([...CONVERSATION_REFERENCE_TYPES]).toEqual(original);
});

test("suggestion feedback retains its public wire values", () => {
  expect(SUGGEST_NEXT_KINDS).toEqual(["text", "slash"]);
  expect(SUGGEST_NEXT_REASONS).toEqual([
    "offer-detected",
    "offer-skill",
    "capability-gap",
    "model",
    "early-conversation",
    "client-suppress",
    "filtered",
    "empty",
    "budget-pressure",
    "turn-abandoned",
    "error",
  ]);
});
