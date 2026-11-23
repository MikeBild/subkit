import { expect, test } from "bun:test";
import { knowledgeSourceReadTools } from "../../../conversations/tools/engine-api/knowledge-sources.ts";

test("the knowledge tools load first without tripping over the parse-file step", async () => {
  expect(knowledgeSourceReadTools.length).toBeGreaterThan(0);
  const palette = await import("../../../conversations/tools/engine-api/index.ts");
  expect(Object.keys(palette).length).toBeGreaterThan(0);
});
