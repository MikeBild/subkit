// What a record is FOR must come from whoever built it, or not be claimed.
//
// Every detail page carried the same sentence — one per resource kind,
// describing the whole catalogue. A reader who opened one workflow to decide
// about it was told "Governed, versioned workflows in this workspace", which is
// true of all of them and therefore says nothing about this one. The engine has
// published each record's own `description` all along.
//
// The fallback matters as much as the value: it falls back to the generic line,
// never to a slug or an id. A name that is really an identifier answers a
// different question than the one the reader asked, and answering the wrong
// question confidently is worse than saying less.

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
  // Whitespace is not a description. Rendering it would replace the generic
  // sentence with an empty line and leave the reader with nothing at all.
  expect(recordPurpose({ description: "   " })).toBeNull();
  // The record has a slug and a name; neither is a purpose, and neither may be
  // substituted for one.
  expect(recordPurpose({ slug: "radar-collect-weekly", name: "Radar collect" })).toBeNull();
});
