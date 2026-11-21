import { describe, expect, test } from "bun:test";
import {
  messageText,
  panelLines,
  panelReference,
  panelSubjectKey,
  panelTarget,
} from "./side-panel-chat-model";

const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

describe("panelReference", () => {
  test("a workflow, connector, skill or source goes along as a reference with its title", () => {
    expect(panelReference({ type: "workflow", id: ID }, "Lieferavise")).toEqual({
      type: "workflow",
      id: ID,
      label: "Lieferavise",
    });
    expect(panelReference({ type: "knowledge_source", id: ID }, null)?.label).toBe(ID);
  });

  test("tasks and files have no reference type on the server", () => {
    expect(panelReference({ type: "task", id: ID }, "Retouren")).toBeNull();
    expect(panelReference({ type: "file", id: `fid_${ID}` }, "a.md")).toBeNull();
    expect(panelReference(null, "Übersicht")).toBeNull();
  });
});

describe("panelTarget and panelSubjectKey", () => {
  test("a new conversation is bound to the workflow or connector it starts from", () => {
    expect(panelTarget({ type: "workflow", id: ID })).toEqual({ workflow_id: ID });
    expect(panelTarget({ type: "connector", id: ID })).toEqual({ connector_id: ID });
    expect(panelTarget({ type: "skill", id: ID })).toBeUndefined();
  });

  test("each record keeps its own panel conversation", () => {
    expect(panelSubjectKey({ type: "task", id: ID })).toBe(`task:${ID}`);
    expect(panelSubjectKey(null)).toBe("workspace");
  });
});

describe("panelLines", () => {
  const message = (id: string, role: string, text: string) => ({
    id,
    role,
    parts: [{ type: "text", text }, { type: "tool-call" }],
  });

  test("shows user and assistant text, nothing else", () => {
    expect(messageText(message("a", "assistant", "Hallo"))).toBe("Hallo");
    expect(
      panelLines({
        messages: [
          message("1", "user", "Frage"),
          message("2", "assistant", "Antwort"),
          message("3", "system", "x"),
        ],
        sent: null,
        streamed: "",
      }).map((line) => [line.author, line.text]),
    ).toEqual([
      ["user", "Frage"],
      ["assistant", "Antwort"],
    ]);
  });

  test("the sent text and the streamed answer show until the transcript has them", () => {
    const lines = panelLines({ messages: [], sent: " Neu ", streamed: "Ant" });
    expect(lines.map((line) => [line.author, line.text, line.streaming ?? false])).toEqual([
      ["user", "Neu", false],
      ["assistant", "Ant", true],
    ]);
    expect(
      panelLines({ messages: [message("1", "user", "Neu")], sent: "Neu", streamed: "" }),
    ).toHaveLength(1);
  });
});
