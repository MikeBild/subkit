import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import type { WorkflowSpec } from "@/features/workflows/model/workflow-spec";
import { SpecFacts } from "./workflow-spec-card";

const spec: WorkflowSpec = {
  goal: "Mail the daily digest",
  inputs: [{ name: "day", description: "Day to report" }],
  outputs: [{ name: "digest" }],
  delivery: { channel: "email", destination: "team@example.com" },
  conventions_applied: [],
  evidence: [],
  open_questions: ["Which time zone?"],
  origin: "chat",
};

test("the card shows goal, inputs, outputs, delivery, open questions and origin", () => {
  const html = render(<SpecFacts spec={spec} />, "en");
  expect(html).toContain("Mail the daily digest");
  expect(html).toContain("Day to report");
  expect(html).toContain("digest");
  expect(html).toContain("email · team@example.com");
  expect(html).toContain("Which time zone?");
  expect(html).toContain("Proposed in chat");
});

test("a person's origin is named in German", () => {
  const html = render(<SpecFacts spec={{ ...spec, origin: "person" }} />, "de");
  expect(html).toContain("Von einer Person angegeben");
  expect(html).toContain("Zustellung");
});

test("a missing spec explains that the purpose is not stated yet", () => {
  const html = render(<SpecFacts spec={null} />, "de");
  expect(html).toContain('data-testid="workflow-spec-empty"');
  expect(html).not.toContain("workflow-spec-facts");
});

test("an unknown goal is shown as open", () => {
  expect(render(<SpecFacts spec={{ ...spec, goal: null }} />, "en")).toContain("Goal still open");
});
