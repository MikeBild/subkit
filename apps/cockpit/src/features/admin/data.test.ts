import { describe, expect, test } from "bun:test";
import { presentRoles, withCurrentRole } from "./data";

describe("roles of people without a role", () => {
  test("offers the current role first when it is not assignable", () => {
    expect(withCurrentRole(["admin", "member"], "auditor")).toEqual(["auditor", "admin", "member"]);
    expect(withCurrentRole(["admin", "member"], "member")).toEqual(["admin", "member"]);
  });

  test("adds no empty choice for a person the contract reports with role null", () => {
    expect(withCurrentRole(["admin", "member"], null)).toEqual(["admin", "member"]);
  });

  test("lists each present role once and skips people without a role", () => {
    expect(
      presentRoles([{ role: "admin" }, { role: null }, { role: "member" }, { role: "admin" }]),
    ).toEqual(["admin", "member"]);
  });
});
