import { expect, test } from "bun:test";
import { listSchedulesTool, scheduleTools } from "./schedules.ts";

test("the schedule tools load as the first import without an import cycle", async () => {
  const { ALL_ENGINE_API_WRITE_TOOLS } = await import("./index.ts");
  expect(scheduleTools).toContain(listSchedulesTool);
  expect(ALL_ENGINE_API_WRITE_TOOLS).toEqual(expect.arrayContaining(scheduleTools));
});
