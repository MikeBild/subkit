import { expect, test } from "bun:test";
import {
  CONVERSATION_RUN_TURN_QUEUE,
  DEVICE_WAIT_QUEUE,
  EXECUTION_RUN_DEVICE_DLQ,
  EXECUTION_RUN_DEVICE_QUEUE,
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  TASK_RUN_TURN_DLQ,
  TASK_RUN_TURN_QUEUE,
} from "./queues.ts";

test("every queue name has exactly one definition carrying its own name", () => {
  expect<string[]>([...QUEUE_NAMES].sort()).toEqual(Object.keys(QUEUE_DEFINITIONS).sort());
  expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  for (const name of QUEUE_NAMES) expect(QUEUE_DEFINITIONS[name].name).toBe(name);
});

test("dead-letter queues follow the <queue>.dlq naming pattern", () => {
  for (const name of QUEUE_NAMES) {
    const deadLetter = QUEUE_DEFINITIONS[name].queue.deadLetter;
    if (deadLetter !== undefined) expect(deadLetter).toBe(`${name}.dlq`);
  }
});

test("a task turn is never retried and expires like a conversation turn", () => {
  expect(TASK_RUN_TURN_QUEUE).toBe("task.run-turn");
  expect(TASK_RUN_TURN_DLQ).toBe("task.run-turn.dlq");
  expect(QUEUE_NAMES).toContain(TASK_RUN_TURN_QUEUE);
  const task = QUEUE_DEFINITIONS[TASK_RUN_TURN_QUEUE].queue;
  const conversation = QUEUE_DEFINITIONS[CONVERSATION_RUN_TURN_QUEUE].queue;
  expect(task.retryLimit).toBe(0);
  expect(task.expireInSeconds).toBe(600);
  expect(task.expireInSeconds).toBe(conversation.expireInSeconds);
  expect(task.retentionSeconds).toBe(conversation.retentionSeconds);
  expect(task.deadLetter).toBe(TASK_RUN_TURN_DLQ);
});

test("a device run has its own queue that never retries by default and expires after an hour", () => {
  expect(EXECUTION_RUN_DEVICE_QUEUE).toBe("execution.run.device");
  expect(QUEUE_NAMES).toContain(EXECUTION_RUN_DEVICE_QUEUE);
  expect(QUEUE_NAMES).toContain(DEVICE_WAIT_QUEUE);
  const device = QUEUE_DEFINITIONS[EXECUTION_RUN_DEVICE_QUEUE].queue;
  expect(device.retryLimit).toBe(0);
  expect(device.expireInSeconds).toBe(3600);
  expect(device.deadLetter).toBe(EXECUTION_RUN_DEVICE_DLQ);
});
