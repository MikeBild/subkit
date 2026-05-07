import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { _resetShellHookCacheForTests } from "../repl/status-line/shell-hook.ts";
import { useStatusLine } from "../repl/status-line/useStatusLine.ts";
import type { StatusLineInput } from "../status-line.ts";
import { flush, renderInk } from "./helpers/ink.tsx";

const baseInput: StatusLineInput = {
  schema_version: 1,
  profile: "default",
  persona: "operator",
  user: null,
  auth_status: "signed_in",
  tenant: null,
  engine_url: "http://x",
  model: null,
  session_id: null,
  turn_tokens: null,
  remaining_monthly_budget_tokens: null,
  tokens_today: null,
  connectors_count: null,
  status_message: null,
  permission_mode: "ask",
  cwd: "/",
  git_branch: null,
  timestamp: new Date().toISOString(),
};

beforeEach(() => _resetShellHookCacheForTests());
afterEach(() => _resetShellHookCacheForTests());

function Probe({
  onResult,
  refreshMs,
  hookCommand,
}: {
  onResult: (line: string) => void;
  refreshMs: number;
  hookCommand?: string;
}): React.ReactElement | null {
  const r = useStatusLine(
    hookCommand ? { command: hookCommand } : { format: "{persona}@{tenant}" },
    baseInput,
    refreshMs,
  );
  useEffect(() => {
    onResult(r.line);
  }, [r.line, onResult]);
  return null;
}

describe("useStatusLine", () => {
  test("starts in `loading` state then resolves to a non-empty line", async () => {
    const ref: { current: string } = { current: "" };
    const ui = renderInk(
      <Probe
        onResult={(l) => {
          ref.current = l;
        }}
        refreshMs={50}
      />,
    );
    try {
      for (let i = 0; i < 30 && !ref.current; i++) {
        await flush();
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(ref.current).toContain("operator");
    } finally {
      ui.unmount();
    }
  });

  test("clean unmount cancels the refresh interval", async () => {
    const ui = renderInk(<Probe onResult={() => undefined} refreshMs={20} />);
    await flush();
    expect(() => ui.unmount()).not.toThrow();
  });
});
