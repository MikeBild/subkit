import { describe, expect, test } from "bun:test";
import { taskSource, taskSourceMessageId } from "./source.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 22, 10, minute));
const first = { id: "m1", role: "user", created_at: at(0) };
const answer = { id: "m2", role: "assistant", created_at: at(1) };
const second = { id: "m3", role: "user", created_at: at(2) };
const later = { id: "m4", role: "user", created_at: at(5) };

describe("the chat message a task serves", () => {
  test("is the latest message the person sent before the task was asked for", () => {
    expect(taskSourceMessageId([first, answer, second, later], at(3))).toBe("m3");
  });

  test("two messages during one turn bind two tasks to their own message", () => {
    const messages = [first, answer, second, later];
    expect(taskSourceMessageId(messages, at(1))).toBe("m1");
    expect(taskSourceMessageId(messages, at(6))).toBe("m4");
  });

  test("a message typed while the task waited for confirmation does not take it over", () => {
    expect(taskSourceMessageId([later, second, first], at(4))).toBe("m3");
  });

  test("a message sent in the same instant still counts", () => {
    expect(taskSourceMessageId([second], at(2))).toBe("m3");
  });

  test("without a message from the person there is no source", () => {
    expect(taskSourceMessageId([answer], at(9))).toBeNull();
    expect(taskSourceMessageId([], at(9))).toBeNull();
  });

  test("a source needs both the conversation and the message", () => {
    expect(taskSource("c1", "m1")).toEqual({ conversation_id: "c1", message_id: "m1" });
    expect(taskSource("c1", null)).toBeNull();
    expect(taskSource(null, "m1")).toBeNull();
  });
});
