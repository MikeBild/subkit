import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import {
  acceptBlockedKey,
  acceptedIndices,
  selectionKey,
  selectionScope,
  stepOperations,
  stepReviewChanges,
  type TestedSelection,
  testedFor,
} from "../model/change-review";
import { ChangeReview, ChangeReviewActions, type ChangeReviewState } from "./change-review";

const operations = stepOperations(
  { id: "fetch", url: "/v1/items", data_selector: "data.items" },
  { id: "fetch", url: "/v2/items", headers: { "x-api-version": "2" } },
);
const changes = stepReviewChanges(operations, (key, params) => translate("en", key, params));

function state(picked: number[], tested: TestedSelection | null = null): ChangeReviewState {
  const selection = new Set(picked);
  const total = operations.length;
  const scope = selectionScope(selection, total);
  const key = selectionKey(selection, total);
  return {
    total,
    selection,
    accepted: acceptedIndices(selection, total),
    partial: scope === "some",
    toggle() {},
    canTest: scope !== "none",
    testing: false,
    test() {},
    result: testedFor(tested, key),
    stale: tested !== null && tested.key !== key,
    blockedKey: acceptBlockedKey({ scope, key, tested, digestRequired: true }),
    digest: null,
  };
}

describe("ChangeReview", () => {
  test("one plain sentence and one checkbox per change", () => {
    const html = render(
      <ChangeReview changes={changes} review={state([0, 1, 2])} testId="r" />,
      "en",
    );
    expect(html).toContain("Removes the place the result is read from.");
    expect(html).toContain("Adds the header x-api-version: 2.");
    expect(html).toContain("Changes the address from /v1/items to /v2/items.");
    expect(html.match(/role="checkbox"/g)?.length).toBe(3);
    expect(html).toContain("3 of 3 selected");
  });

  test("a change that is left out is marked and counted", () => {
    const html = render(<ChangeReview changes={changes} review={state([0, 2])} testId="r" />, "en");
    expect(html).toContain('data-testid="r-change-1" data-state="left-out"');
    expect(html).toContain("2 of 3 selected");
  });

  test("a single change has nothing to choose", () => {
    const one = changes.slice(0, 1);
    const html = render(
      <ChangeReview changes={one} review={{ ...state([0]), total: 1 }} testId="r" />,
      "en",
    );
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain('data-testid="r-intro"');
  });

  test("shows the test outcome for the tested selection and flags a changed selection", () => {
    const tested = { key: "0,2", result: { ok: false, error: "HTTP 404", digest: null } };
    const failed = render(
      <ChangeReview changes={changes} review={state([0, 2], tested)} testId="r" />,
      "en",
    );
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain("The test failed. HTTP 404");
    const stale = render(
      <ChangeReview changes={changes} review={state([0], tested)} testId="r" />,
      "en",
    );
    expect(stale).toContain("You changed the selection after the test.");
  });
});

describe("ChangeReviewActions", () => {
  test("each action appears once and a subset waits for its test", () => {
    const html = render(
      <ChangeReviewActions review={state([0, 2])} onAcceptAndSave={() => {}} testId="a" />,
      "en",
    );
    expect(html.match(/data-testid="a-test-first"/g)?.length).toBe(1);
    expect(html.match(/data-testid="a-accept-save"/g)?.length).toBe(1);
    expect(html).not.toContain('data-testid="a-accept"');
    expect(html).toMatch(
      /disabled=""[^>]*title="Test this selection first\."|title="Test this selection first\."[^>]*disabled=""/,
    );
  });

  test("the whole change can be accepted without a test, an empty selection cannot", () => {
    const whole = render(
      <ChangeReviewActions review={state([0, 1, 2])} onAccept={() => {}} testId="a" />,
      "en",
    );
    expect(whole).toContain('data-testid="a-accept"');
    expect(whole).not.toContain("title=");
    const none = render(
      <ChangeReviewActions review={state([])} onAccept={() => {}} testId="a" />,
      "en",
    );
    expect(none).toContain("Select at least one change.");
    expect(none).not.toContain('data-testid="a-test-first"');
  });
});
