import { expect, test } from "bun:test";
import { recordPurpose } from "./catalog-model";

test("a record's own description is what it is for", () => {
  expect(
    recordPurpose({ description: "Weekly: refresh project cards, then publish one release." }),
  ).toBe("Weekly: refresh project cards, then publish one release.");
});

test("no description means no claim — never an identifier standing in for one", () => {
  expect(recordPurpose(undefined)).toBeNull();
  expect(recordPurpose({})).toBeNull();
  expect(recordPurpose({ description: null })).toBeNull();
  expect(recordPurpose({ description: "   " })).toBeNull();
  expect(recordPurpose({ slug: "radar-collect-weekly", name: "Radar collect" })).toBeNull();
});
