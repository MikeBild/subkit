import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import type { SpendPanel } from "./spend-model";
import { SpendPanelView } from "./spend-panel";

const reached: SpendPanel = {
  state: "reached",
  spent: 52,
  limit: 50,
  pct: 104,
  tone: "danger",
  canRaise: true,
  canContinue: true,
  choices: [200, 0],
};

function panel(value: SpendPanel | null, intent: "raise" | "continue" | null = null) {
  return render(
    <SpendPanelView
      panel={value}
      usd={(amount) => `${amount} $`}
      intent={intent}
      saving={false}
      saveError={null}
      onRaise={() => {}}
      onContinue={() => {}}
    />,
  );
}

test("a reached budget offers both ways out", () => {
  const html = panel(reached);
  expect(html).toContain('data-state="reached"');
  expect(html).toContain("Grenze erreicht");
  expect(html).toContain("52 $");
  expect(html).toContain("von 50 $");
  expect(html).toContain("us-spend-continue");
  expect(html).toContain("Budget erhöhen");
  expect(html).not.toContain("us-spend-choices");
});

test("the raise link opens the choices at once", () => {
  const html = panel(reached, "raise");
  expect(html).toContain("us-spend-choice-200");
  expect(html).toContain("Ohne Grenze");
});

test("the amount choices are one segment toggle, not pressed buttons", () => {
  const html = panel({ ...reached, limit: 200 }, "raise");
  expect(html).toContain('data-slot="segmented-choices"');
  expect(html).not.toContain("aria-pressed");
  expect(html).toMatch(
    /data-state="on"[^>]*data-testid="us-spend-choice-200"|data-testid="us-spend-choice-200"[^>]*data-state="on"/,
  );
});

test("a person who may not change it sees the figure only", () => {
  const html = panel({ ...reached, canRaise: false, canContinue: false });
  expect(html).not.toContain("us-spend-continue");
  expect(html).not.toContain("us-spend-raise");
});

test("loading keeps the panel's shape, a failed read offers a retry", () => {
  expect(
    render(
      <SpendPanelView
        panel={null}
        loading
        usd={String}
        intent={null}
        saving={false}
        saveError={null}
        onRaise={() => {}}
        onContinue={() => {}}
      />,
    ),
  ).toContain("us-spend-loading");
  const failed = render(
    <SpendPanelView
      panel={null}
      failed
      usd={String}
      intent={null}
      saving={false}
      saveError={null}
      onRaise={() => {}}
      onContinue={() => {}}
    />,
  );
  expect(failed).toContain("us-spend-failed");
  expect(failed).not.toContain("us-spend-none");
});
