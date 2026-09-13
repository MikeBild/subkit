import { describe, expect, test } from "bun:test";

import { createQueue } from "../repl/queue.ts";

describe("command queue", () => {
  test("enqueue / dequeue preserves FIFO order", () => {
    const q = createQueue();
    q.enqueue("one");
    q.enqueue("two");
    q.enqueue("three");
    expect(q.length).toBe(3);
    expect(q.dequeue()).toBe("one");
    expect(q.dequeue()).toBe("two");
    expect(q.dequeue()).toBe("three");
    expect(q.dequeue()).toBeUndefined();
  });

  test("trims whitespace-only entries", () => {
    const q = createQueue();
    expect(q.enqueue("   ")).toBe(false);
    expect(q.enqueue("")).toBe(false);
    expect(q.length).toBe(0);
  });

  test("peek does not consume", () => {
    const q = createQueue();
    q.enqueue("a");
    expect(q.peek()).toBe("a");
    expect(q.length).toBe(1);
  });

  test("overflow drops newest push", () => {
    const q = createQueue({ maxSize: 2 });
    expect(q.enqueue("a")).toBe(true);
    expect(q.enqueue("b")).toBe(true);
    expect(q.enqueue("c")).toBe(false);
    expect([...q.items]).toEqual(["a", "b"]);
  });

  test("clear empties the queue", () => {
    const q = createQueue();
    q.enqueue("a");
    q.enqueue("b");
    q.clear();
    expect(q.length).toBe(0);
  });

  test("items returns a live-ish view", () => {
    const q = createQueue();
    q.enqueue("a");
    expect([...q.items]).toEqual(["a"]);
    q.enqueue("b");
    expect([...q.items]).toEqual(["a", "b"]);
  });
});
