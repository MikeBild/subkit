import { expect, test } from "bun:test";
import { nameFromEmail } from "@/features/setup/model/display-name";

test("an email address suggests a readable name", () => {
  expect(nameFromEmail("mira.kessler@example.com")).toBe("Mira Kessler");
  expect(nameFromEmail("jonas_albrecht-meier+team@example.com")).toBe("Jonas Albrecht Meier Team");
  expect(nameFromEmail("mira@example.com")).toBe("Mira");
  expect(nameFromEmail("")).toBe("");
});
