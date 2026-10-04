import { expect, test } from "bun:test";
import { resolveWorkflowNameBySlug } from "./name-index";

const catalogue = [
  { slug: "ga4-daily-report", name: "Daily traffic report" },
  { slug: "radar-collect-weekly", name: "radar-collect-weekly" },
  { slug: "no-name", name: null },
];

test("a slug is answered with the name its author gave it", () => {
  expect(resolveWorkflowNameBySlug(catalogue, "ga4-daily-report")).toBe("Daily traffic report");
});

test("nothing better than the slug means the slug stands", () => {
  expect(resolveWorkflowNameBySlug(catalogue, "never-heard-of-it")).toBeNull();
  expect(resolveWorkflowNameBySlug(catalogue, "radar-collect-weekly")).toBeNull();
  expect(resolveWorkflowNameBySlug(catalogue, "no-name")).toBeNull();
});
