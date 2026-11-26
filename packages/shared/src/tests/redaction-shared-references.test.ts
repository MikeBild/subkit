import { describe, expect, test } from "bun:test";
import { scrubSecrets, scrubStringsDeep } from "../redaction.ts";

const SCRUB_SECRETS_MAX_DEPTH = 16;
const sharedArgv = ["bun", "agent.js"];
const sharedRecord = { name: "agent", tags: sharedArgv };
const selfCycle: Record<string, unknown> = { label: "root" };
selfCycle.self = selfCycle;
const indirectCycle: Record<string, unknown> = { label: "outer" };
indirectCycle.child = { label: "inner", parent: indirectCycle };
const cycleBesideShared: Record<string, unknown> = { first: sharedArgv, second: sharedArgv };
cycleBesideShared.loop = [cycleBesideShared];

const deeplyNested = (levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>((inner) => ({ inner }), "leaf");

const serializerCases = [
  {
    name: "a shared array referenced twice is serialized twice",
    input: { top: sharedArgv, outer: { arr: sharedArgv } },
    expected: { top: ["bun", "agent.js"], outer: { arr: ["bun", "agent.js"] } },
  },
  {
    name: "a shared object referenced inside an array and a record is serialized each time",
    input: { list: [sharedRecord, sharedRecord], single: sharedRecord },
    expected: {
      list: [
        { name: "agent", tags: ["bun", "agent.js"] },
        { name: "agent", tags: ["bun", "agent.js"] },
      ],
      single: { name: "agent", tags: ["bun", "agent.js"] },
    },
  },
  {
    name: "a direct self cycle becomes [circular]",
    input: selfCycle,
    expected: { label: "root", self: "[circular]" },
  },
  {
    name: "an indirect cycle becomes [circular] at the back edge",
    input: indirectCycle,
    expected: { label: "outer", child: { label: "inner", parent: "[circular]" } },
  },
  {
    name: "a cycle next to shared references only marks the back edge",
    input: cycleBesideShared,
    expected: {
      first: ["bun", "agent.js"],
      second: ["bun", "agent.js"],
      loop: ["[circular]"],
    },
  },
] as const;

describe("redaction serializers detect cycles only along the ancestor path", () => {
  for (const serialize of [scrubStringsDeep, (value: unknown) => scrubSecrets(value)]) {
    for (const serializerCase of serializerCases) {
      test(`${serialize === scrubStringsDeep ? "scrubStringsDeep" : "scrubSecrets"}: ${serializerCase.name}`, () => {
        expect(serialize(serializerCase.input)).toEqual(serializerCase.expected);
      });
    }

    test("the depth limit is unchanged", () => {
      const withinLimit = JSON.stringify(serialize(deeplyNested(SCRUB_SECRETS_MAX_DEPTH)));
      const beyondLimit = JSON.stringify(serialize(deeplyNested(SCRUB_SECRETS_MAX_DEPTH + 1)));
      expect(withinLimit).toContain('"leaf"');
      expect(withinLimit).not.toContain("[depth-exceeded]");
      expect(beyondLimit).toContain("[depth-exceeded]");
      expect(beyondLimit).not.toContain('"leaf"');
    });
  }
});
