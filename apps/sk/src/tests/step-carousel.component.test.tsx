import { ThemeProvider } from "@chat-ui/index.ts";
import { describe, expect, test } from "bun:test";

import {
  StepCarousel,
  type StepCarouselTab,
  type WorkflowRunSnapshot,
} from "../domain/workflows/StepCarousel.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const RUN: WorkflowRunSnapshot = {
  id: "run-1",
  status: "succeeded",
  payload: { user_id: "u1" },
  steps: [
    {
      id: "s1",
      name: "fetch_user",
      kind: "request",
      status: "succeeded",
      input: { id: "u1" },
      output: { name: "Alice" },
    },
    {
      id: "s2",
      name: "transform_user",
      kind: "transform",
      status: "succeeded",
      input: { name: "Alice" },
      output: { greeting: "Hi Alice" },
    },
    {
      id: "s3",
      name: "post_event",
      kind: "request",
      status: "failed",
      input: {},
      error: "ECONNREFUSED",
    },
  ],
  transform: { expression: "$.greeting", result: "Hi Alice", error: null },
};

describe("<StepCarousel>", () => {
  test("renders the payload tab by default with the input JSON", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <StepCarousel run={RUN} active="payload" onTab={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("payload:");
      expect(text).toContain("user_id");
    } finally {
      ui.unmount();
    }
  });

  test("renders the active step on the steps tab with status badge", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <StepCarousel run={RUN} active="steps" onTab={() => undefined} activeStep={0} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("step 1/3");
      expect(text).toContain("fetch_user");
      expect(text).toContain("[ok]");
    } finally {
      ui.unmount();
    }
  });

  test("failed step shows the error inline in red instead of output", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <StepCarousel run={RUN} active="steps" onTab={() => undefined} activeStep={2} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("[failed]");
      expect(text).toContain("ECONNREFUSED");
    } finally {
      ui.unmount();
    }
  });

  test("transform tab renders expression + result", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <StepCarousel run={RUN} active="transform" onTab={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("expression:");
      expect(text).toContain("$.greeting");
      expect(text).toContain("Hi Alice");
    } finally {
      ui.unmount();
    }
  });

  test("Tab cycles through tabs (payload -> steps -> transform -> payload)", async () => {
    const ref: { tab: StepCarouselTab; renders: number } = { tab: "payload", renders: 0 };
    const handleTab = (t: StepCarouselTab): void => {
      ref.tab = t;
      ref.renders++;
    };
    const ui = renderInk(
      <ThemeProvider>
        <StepCarousel run={RUN} active={ref.tab} onTab={handleTab} />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.press("tab");
      await flush();
      expect(ref.tab).toBe("steps");
      expect(ref.renders).toBeGreaterThan(0);
    } finally {
      ui.unmount();
    }
  });
});
