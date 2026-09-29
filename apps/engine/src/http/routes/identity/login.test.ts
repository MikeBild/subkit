import { expect, test } from "bun:test";
import { apiKeyLoginRefusal } from "./login.ts";

test("a refused API key is explained in the page's language", () => {
  expect(apiKeyLoginRefusal("de")).toContain("API-Schlüssel ist ungültig");
  expect(apiKeyLoginRefusal("de")).not.toMatch(/invalid|expired|owned/);
  expect(apiKeyLoginRefusal("en")).toContain("not owned by a person");
});
