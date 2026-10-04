import { describe, expect, test } from "bun:test";
import { type AssistantTurnRef, ConversationBrowser } from "@chat-ui/index.ts";
import { renderInk } from "./helpers/ink.tsx";

const items = [
  {
    id: "abcdef0123456789",
    title: "session one",
    updated_at: "2026-05-01T12:00:00Z",
    last_message_role: "assistant",
    last_message_excerpt: "ready",
  },
];

const turns: AssistantTurnRef[] = [
  {
    message_id: "11111111-1111-1111-1111-111111111111",
    excerpt: "first reply: pinged the engine",
    created_at: "2026-05-01T12:00:01Z",
  },
  {
    message_id: "22222222-2222-2222-2222-222222222222",
    excerpt: "second reply: drafted the workflow",
    created_at: "2026-05-01T12:00:30Z",
  },
];

describe("ConversationBrowser — rewind toggle (M10 + G10)", () => {
  test("session-list view is the default", async () => {
    const ui = renderInk(<ConversationBrowser items={items} onSelect={() => {}} />);
    try {
      await ui.waitFor((t) => t.includes("session one"));
      expect(ui.text()).toContain("session one");
      expect(ui.text()).not.toContain("from earlier turn");
    } finally {
      ui.unmount();
    }
  });

  test("`t` with no currentTurns shows empty-state message", async () => {
    const ui = renderInk(<ConversationBrowser items={items} onSelect={() => {}} />);
    try {
      await ui.waitFor((t) => t.includes("session one"));
      await ui.type("t");
      await ui.waitFor((t) => t.includes("from earlier turn"));
      const txt = ui.text();
      expect(txt).toContain("from earlier turn");
      expect(txt).toContain("No assistant turns");
    } finally {
      ui.unmount();
    }
  });

  test("`t` with currentTurns renders the timeline rows", async () => {
    const ui = renderInk(
      <ConversationBrowser items={items} onSelect={() => {}} currentTurns={turns} />,
    );
    try {
      await ui.waitFor((t) => t.includes("session one"));
      await ui.type("t");
      await ui.waitFor((t) => t.includes("first reply"));
      const txt = ui.text();
      expect(txt).toContain("first reply: pinged the engine");
      expect(txt).toContain("second reply: drafted the workflow");
      expect(txt).toContain("2 assistant turns");
    } finally {
      ui.unmount();
    }
  });

  test("Enter on a turn invokes onForkFromTurn with the message id", async () => {
    let forked = "";
    const ui = renderInk(
      <ConversationBrowser
        items={items}
        onSelect={() => {}}
        currentTurns={turns}
        onForkFromTurn={(msg) => {
          forked = msg;
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("session one"));
      await ui.type("t");
      await ui.waitFor((t) => t.includes("first reply"));
      await ui.press("down");
      await ui.press("enter");
      await ui.waitFor(() => forked !== "", { tries: 50, sleepMs: 10 });
      expect(forked).toBe("22222222-2222-2222-2222-222222222222");
    } finally {
      ui.unmount();
    }
  });

  test("`t` toggles back to session list", async () => {
    const ui = renderInk(<ConversationBrowser items={items} onSelect={() => {}} />);
    try {
      await ui.waitFor((t) => t.includes("session one"));
      await ui.type("t");
      await ui.waitFor((t) => t.includes("from earlier turn"));
      await ui.type("t");
      await ui.waitFor((t) => t.includes("session one") && !t.includes("from earlier turn"));
      expect(ui.text()).toContain("session one");
    } finally {
      ui.unmount();
    }
  });

  test("Enter while in rewind view with no turns and no callback is a no-op", async () => {
    let selected = "";
    const ui = renderInk(
      <ConversationBrowser
        items={items}
        onSelect={(id) => {
          selected = id;
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("session one"));
      await ui.type("t");
      await ui.waitFor((t) => t.includes("from earlier turn"));
      await ui.press("enter");
      await ui.flush();
      await ui.flush();
      expect(selected).toBe("");
    } finally {
      ui.unmount();
    }
  });
});
