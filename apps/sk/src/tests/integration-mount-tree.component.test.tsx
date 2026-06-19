// End-to-end mount-tree integration test for the new sk shell.
//
// Renders the full proposed mount tree (Theme → Resize → Toast → app
// content) and exercises a typical operator flow:
//   1. theme switches between dark/light at runtime
//   2. an error from the engine renders via ErrorPanel + retry-after
//   3. a slash suggestion appears, then the operator picks one
//   4. a toast is pushed, auto-dismisses, and is gone
//
// The surfaces are mounted together rather than in isolation so we
// catch composition bugs that single-component tests miss
// (theme-context propagation, toast queue placement under
// ResizeBoundary, etc.).

import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  ErrorPanel,
  ResizeBoundary,
  SlashSuggest,
  type ThemeName,
  ThemeProvider,
  ToastQueue,
  useThemeControl,
  useToast,
} from "../shell/index.ts";
import { flush, renderInk } from "./helpers/ink.tsx";

function App({
  errorRetryAfter,
  pushToastTitle,
  buffer,
  cursor,
}: {
  errorRetryAfter?: number;
  pushToastTitle?: string;
  buffer: string;
  cursor: number;
}): React.ReactElement {
  const toast = useToast();
  const { name } = useThemeControl();
  useEffect(() => {
    if (pushToastTitle)
      toast.push({ id: "fixed-toast", title: pushToastTitle, level: "info", ttlMs: 50 });
    // toast.push is stable enough; we want the effect to fire once per
    // pushToastTitle change, not whenever the queue redraws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToastTitle]);

  return (
    <Box flexDirection="column">
      <Text>theme={name}</Text>
      {errorRetryAfter !== undefined ? (
        <ErrorPanel
          kind="rate-limit"
          payload={{
            message: "slow down",
            retry_after: errorRetryAfter,
            hint: "try again later",
          }}
        />
      ) : null}
      <SlashSuggest
        buffer={buffer}
        cursor={cursor}
        persona={{ allows: () => true }}
        showWelcomeHint
      />
    </Box>
  );
}

function ThemeSwitch({ to }: { to: ThemeName }): React.ReactElement | null {
  const { setTheme } = useThemeControl();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) {
      setTheme(to);
      setDone(true);
    }
  }, [to, setTheme, done]);
  return null;
}

describe("sk overhaul — mount tree integration", () => {
  test("Theme + Resize + Toast wrappers compose cleanly", async () => {
    const ui = renderInk(
      <ThemeProvider name="dark" forceNoColor={false}>
        <ResizeBoundary minCols={20} minRows={5}>
          <ToastQueue>
            <App buffer="" cursor={0} />
          </ToastQueue>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("theme=dark");
      // Welcome hint from SlashSuggest renders inside this composed tree.
      expect(ui.text()).toMatch(/press.*\/.*command/);
    } finally {
      ui.unmount();
    }
  });

  test("ErrorPanel renders inside the tree and surfaces retry countdown", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ResizeBoundary>
          <ToastQueue>
            <App buffer="" cursor={0} errorRetryAfter={7} />
          </ToastQueue>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("rate limit");
      expect(text).toContain("retry available in 7s");
      expect(text).toContain("try again later");
    } finally {
      ui.unmount();
    }
  });

  test("Theme switch propagates through the tree at runtime", async () => {
    const ui = renderInk(
      <ThemeProvider name="dark" forceNoColor={false}>
        <ResizeBoundary>
          <ToastQueue>
            <App buffer="" cursor={0} />
            <ThemeSwitch to="highContrast" />
          </ToastQueue>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      for (let i = 0; i < 20 && !ui.text().includes("theme=highContrast"); i++) {
        await flush();
      }
      expect(ui.text()).toContain("theme=highContrast");
    } finally {
      ui.unmount();
    }
  });

  test("Slash typing inside the tree shows ranked suggestions", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ResizeBoundary>
          <ToastQueue>
            <App buffer="/he" cursor={3} />
          </ToastQueue>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("/help");
    } finally {
      ui.unmount();
    }
  });

  test("Toast auto-dismisses inside the tree without leaking", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ResizeBoundary>
          <ToastQueue defaultTtlMs={30}>
            <App buffer="" cursor={0} pushToastTitle="hi from toast" />
          </ToastQueue>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      await ui.waitFor((t) => t.includes("hi from toast"));
      // Toast TTL is 30ms; the queue prunes on a 250ms setInterval
      // tick. Both are macrotasks; sleepMs opts into wall-clock
      // progress for the prune cycle.
      await ui.waitFor((t) => !t.includes("hi from toast"), { tries: 30, sleepMs: 50 });
      expect(ui.text()).not.toContain("hi from toast");
    } finally {
      ui.unmount();
    }
  });
});
