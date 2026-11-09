import { expect, test } from "bun:test";
import { extractTemplatePlaceholders } from "./connector-template-intelligence.ts";
import { extractTemplatePlaceholders as coreExtract } from "./core/template-placeholders.ts";

test("connector intelligence preserves the public placeholder extraction contract", () => {
  expect(extractTemplatePlaceholders).toBe(coreExtract);
  expect(extractTemplatePlaceholders("https://{host}/{tenant}/{host}")).toEqual(["host", "tenant"]);
});
