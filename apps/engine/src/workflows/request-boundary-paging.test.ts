import { expect, test } from "bun:test";
import { describePagedBodyViolation, pagedBodyParts } from "./request-boundary-paging.ts";

test("the paging fields are set aside and the rest of the body is compared canonically", () => {
  expect(pagedBodyParts(["cursor"], { b: 1, a: 2, cursor: "c1" })).toEqual({
    rest: '{"a":2,"b":1}',
  });
  expect(pagedBodyParts(["cursor"], '{"cursor":7,"a":2}')).toEqual({ rest: '{"a":2}' });
});

test("a body that is not an object or carries a structured paging value is refused", () => {
  expect(pagedBodyParts(["cursor"], "[1]")).toEqual({ reason: "not_an_object" });
  expect(pagedBodyParts(["cursor"], "{")).toEqual({ reason: "not_an_object" });
  expect(pagedBodyParts(["cursor"], { cursor: { next: 1 } })).toEqual({
    reason: "paging_value",
    field: "cursor",
  });
  expect(describePagedBodyViolation({ reason: "paging_value", field: "cursor" })).toContain(
    "`cursor`",
  );
  expect(describePagedBodyViolation({ reason: "changed_between_pages" })).toContain("later page");
});
