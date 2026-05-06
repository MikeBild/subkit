import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { Text } from "ink";
import { useEffect } from "react";
import { ToastQueue, useToast } from "../shell/ToastQueue.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

function PushOnce({
  title,
  level,
}: {
  title: string;
  level: "error" | "info" | "success" | "warn";
}) {
  const toast = useToast();
  useEffect(() => {
    toast.push({ title, level });
  }, [toast, title, level]);
  return null;
}

function ManualController({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  useEffect(() => onReady(api), [onReady, api]);
  return null;
}

describe("<ToastQueue> component", () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.NO_COLOR;
    delete process.env.SK_PLAIN;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("renders nothing when empty", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ToastQueue>
          <Text>just-children</Text>
        </ToastQueue>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("just-children");
      expect(ui.text()).not.toContain("✗");
      expect(ui.text()).not.toContain("✓");
    } finally {
      ui.unmount();
    }
  });

  test("renders pushed toast title + icon", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ToastQueue>
          <Text>x</Text>
          <PushOnce title="connected" level="success" />
        </ToastQueue>
      </ThemeProvider>,
    );
    try {
      await ui.waitFor((t) => t.includes("connected"));
      const out = ui.text();
      expect(out).toContain("✓");
      expect(out).toContain("connected");
    } finally {
      ui.unmount();
    }
  });

  test("severity icons differ between error and info", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ToastQueue>
          <Text>x</Text>
          <PushOnce title="oops" level="error" />
          <PushOnce title="hint" level="info" />
        </ToastQueue>
      </ThemeProvider>,
    );
    try {
      await ui.waitFor((t) => t.includes("oops") && t.includes("hint"));
      const out = ui.text();
      expect(out).toContain("✗");
      expect(out).toContain("i");
    } finally {
      ui.unmount();
    }
  });

  test("dismiss removes a toast from the visible set", async () => {
    let api: ReturnType<typeof useToast> | null = null;
    const capture = (a: ReturnType<typeof useToast>) => {
      api = a;
    };
    const ui = renderInk(
      <ThemeProvider>
        <ToastQueue>
          <Text>x</Text>
          <ManualController onReady={capture} />
        </ToastQueue>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(api).not.toBeNull();
      const id = api!.push({ title: "to-dismiss", level: "warn" });
      await ui.waitFor((t) => t.includes("to-dismiss"));
      api!.dismiss(id);
      await ui.waitFor((t) => !t.includes("to-dismiss"));
      expect(ui.text()).not.toContain("to-dismiss");
    } finally {
      ui.unmount();
    }
  });

  test("maxVisible caps the rendered list", async () => {
    let api: ReturnType<typeof useToast> | null = null;
    const capture = (a: ReturnType<typeof useToast>) => {
      api = a;
    };
    const ui = renderInk(
      <ThemeProvider>
        <ToastQueue maxVisible={2}>
          <Text>x</Text>
          <ManualController onReady={capture} />
        </ToastQueue>
      </ThemeProvider>,
    );
    try {
      await flush();
      api!.push({ title: "alpha", level: "info" });
      api!.push({ title: "bravo", level: "info" });
      api!.push({ title: "charlie", level: "info" });
      await ui.waitFor((t) => t.includes("alpha") && t.includes("bravo"));
      // Newest "charlie" was pushed but should not display because the
      // FIFO order keeps the older two visible up to maxVisible.
      expect(ui.text()).toContain("alpha");
      expect(ui.text()).toContain("bravo");
      expect(ui.text()).not.toContain("charlie");
    } finally {
      ui.unmount();
    }
  });
});
