// The breadcrumb stands on a record's own page and nowhere else.

import { expect, test } from "bun:test";
import { recordListPath } from "./record-crumb";

const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

test("a record's page names the list it belongs to", () => {
  for (const list of ["workflows", "connectors", "knowledge", "skills", "files", "runs"])
    expect(recordListPath(`/cockpit/${list}/${ID}`)).toBe(`/${list}`);
  // Router-relative works the same.
  expect(recordListPath(`/runs/${ID}`)).toBe("/runs");
});

test("a list page carries no breadcrumb — its title already says where the reader is", () => {
  for (const path of ["/cockpit", "/cockpit/workflows", "/cockpit/runs", "/cockpit/settings"])
    expect(recordListPath(path)).toBeNull();
});

test("a conversation is not a record page, and deeper paths are not either", () => {
  expect(recordListPath(`/cockpit/chat/${ID}`)).toBeNull();
  expect(recordListPath("/cockpit/chat/new")).toBeNull();
  expect(recordListPath(`/cockpit/workflows/${ID}/versions`)).toBeNull();
});
