import { describe, expect, test } from "bun:test";
import {
  messageText,
  panelConversationId,
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

describe("panelConversationId", () => {
  const RUN_CONVERSATION = "018f4b4a-6d33-7b3a-9c2d-00000000c0de";
  const OWN = "018f4b4a-6d33-7b3a-9c2d-0000000000aa";
  const OWNER = "018f4b4a-6d33-7b3a-9c2d-0000000000b1";
  const OTHER = "018f4b4a-6d33-7b3a-9c2d-0000000000b2";
  const task = { type: "task", id: ID } as const;
  const ran = { conversationId: RUN_CONVERSATION, ownerId: OWNER };
  const owner = { id: OWNER, admin: false };

  test("the task's owner gets the conversation of its latest run attached", () => {
    expect(panelConversationId({ subject: task, thread: null, task: ran, viewer: owner })).toBe(
      RUN_CONVERSATION,
    );
  });

  test("an administrator gets it attached as well", () => {
    expect(
      panelConversationId({
        subject: task,
        thread: null,
        task: ran,
        viewer: { id: OTHER, admin: true },
      }),
    ).toBe(RUN_CONVERSATION);
  });

  test("another member keeps a new conversation, since only owner and admin may continue a run", () => {
    expect(
      panelConversationId({
        subject: task,
        thread: null,
        task: ran,
        viewer: { id: OTHER, admin: false },
      }),
    ).toBeNull();
    expect(
      panelConversationId({
        subject: task,
        thread: null,
        task: { conversationId: RUN_CONVERSATION, ownerId: null },
        viewer: { id: null, admin: false },
      }),
    ).toBeNull();
  });

  test("a task without a run, or not loaded yet, starts a new conversation", () => {
    expect(
      panelConversationId({
        subject: task,
        thread: null,
        task: { conversationId: null, ownerId: OWNER },
        viewer: owner,
      }),
    ).toBeNull();
    expect(
      panelConversationId({ subject: task, thread: null, task: null, viewer: owner }),
    ).toBeNull();
  });

  test("other subjects never pick up a run conversation", () => {
    expect(
      panelConversationId({
        subject: { type: "workflow", id: ID },
        thread: null,
        task: ran,
        viewer: owner,
      }),
    ).toBeNull();
    expect(
      panelConversationId({ subject: null, thread: null, task: ran, viewer: owner }),
    ).toBeNull();
  });

  test("a thread the panel already holds wins", () => {
    expect(panelConversationId({ subject: task, thread: OWN, task: ran, viewer: owner })).toBe(OWN);
    expect(
      panelConversationId({
        subject: { type: "skill", id: ID },
        thread: OWN,
        task: null,
        viewer: { id: OTHER, admin: false },
      }),
    ).toBe(OWN);
  });
});
