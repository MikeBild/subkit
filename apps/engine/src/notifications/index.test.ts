import { expect, test } from "bun:test";
import * as notifications from "./index.ts";

test("notification public entrypoint exposes admin and dispatch operations", () => {
  expect(notifications.createChannel).toBeFunction();
  expect(notifications.listRules).toBeFunction();
  expect(notifications.listInbox).toBeFunction();
  expect(notifications.dispatchEvent).toBeFunction();
});
