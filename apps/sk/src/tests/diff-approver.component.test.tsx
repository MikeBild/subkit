import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { DiffApprover, type DiffHunk } from "../domain/workflows/DiffApprover.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const HUNKS: DiffHunk[] = [
  {
    id: "h1",
    label: "steps[0].request.url",
    lines: [
      { kind: "context", text: '"url":' },
      { kind: "removed", text: ' "https://api.old/v1/users"' },
      { kind: "added", text: ' "https://api.new/v1/users"' },
    ],
  },
  {
    id: "h2",
    label: "steps[1].transform.expr",
    lines: [
      { kind: "removed", text: "$.payload.user" },
      { kind: "added", text: "$.payload.user_id" },
    ],
  },
];

describe("<DiffApprover>", () => {
  test("renders all hunks with default selection (all selected)", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <DiffApprover hunks={HUNKS} onAccept={() => undefined} onReject={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("approve diff");
      expect(text).toContain("steps[0].request.url");
      expect(text).toContain("steps[1].transform.expr");
      expect(text).toContain("[x]");
      expect(text).toContain("2/2 hunks selected");
    } finally {
      ui.unmount();
    }
  });

  test("Space toggles the active hunk", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <DiffApprover hunks={HUNKS} onAccept={() => undefined} onReject={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type(" ");
      await flush();
      const text = ui.text();
      expect(text).toContain("1/2 hunks selected");
    } finally {
      ui.unmount();
    }
  });

  test("`n` deselects all", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <DiffApprover hunks={HUNKS} onAccept={() => undefined} onReject={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type("n");
      await flush();
      expect(ui.text()).toContain("0/2 hunks selected");
    } finally {
      ui.unmount();
    }
  });

  test("`a` selects all (after deselecting)", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <DiffApprover
          hunks={HUNKS}
          onAccept={() => undefined}
          onReject={() => undefined}
          initialSelected={[]}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("0/2 hunks selected");
      await ui.type("a");
      await flush();
      expect(ui.text()).toContain("2/2 hunks selected");
    } finally {
      ui.unmount();
    }
  });

  test("Enter submits the selected ids via onAccept and the rest via onReject", async () => {
    const captured: { accepted: string[] | null; rejected: string[] | null } = {
      accepted: null,
      rejected: null,
    };
    const ui = renderInk(
      <ThemeProvider>
        <DiffApprover
          hunks={HUNKS}
          initialSelected={["h1"]}
          onAccept={(ids) => {
            captured.accepted = ids;
          }}
          onReject={(ids) => {
            captured.rejected = ids;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.press("enter");
      await flush();
      expect(captured.accepted).toEqual(["h1"]);
      expect(captured.rejected).toEqual(["h2"]);
    } finally {
      ui.unmount();
    }
  });

  test("zero hunks renders a no-op message", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <DiffApprover hunks={[]} onAccept={() => undefined} onReject={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("nothing to apply");
    } finally {
      ui.unmount();
    }
  });
});
