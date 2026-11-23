import { expect, test } from "bun:test";
import { proposedRule } from "./core/boundary-derivation.ts";
import {
  compileRequestBoundary,
  describeRequestBoundaryViolation,
  type RequestBoundary,
  requestBoundaryViolation,
  VALUE_CLASSES,
} from "./request-boundary.ts";
import { step } from "./request-boundary-fixtures.ts";

const GMAIL = "https://gmail.googleapis.com";
const TEMPLATE = "/gmail/v1/users/me/messages/${item.messageId}/attachments/${item.attachmentId}";
const MESSAGE_ID = "18c2f4a9b7e1d3c0";

function attachmentId(length: number): string {
  const alphabet = "ANGjdJ8wXk-_0123456789abcdefghijklmnopqrstuvwxyzQRSTUV";
  return Array.from({ length }, (_, index) => alphabet[(index * 7) % alphabet.length]).join("");
}

function boundary(attachmentClass: string): RequestBoundary {
  const compiled = compileRequestBoundary(
    step({
      method: "GET",
      path: TEMPLATE,
      boundary: {
        variables: {
          "item.messageId": { class: "identifier" },
          "item.attachmentId": { class: attachmentClass },
        },
        max_body_bytes: 0,
        max_calls: 50,
      },
    }),
    GMAIL,
  );
  expect(compiled.refusal).toBeUndefined();
  return compiled.boundary as RequestBoundary;
}

const get = (url: string, method = "GET") => ({ method, url, headers: {}, body: null });
const attachmentUrl = (id: string, message = MESSAGE_ID, origin = GMAIL) =>
  `${origin}/gmail/v1/users/me/messages/${message}/attachments/${id}`;

test("a long attachment id from an earlier step fits the declared template", () => {
  const reviewed = boundary("long_identifier");
  for (const length of [300, 800, 1024])
    expect(requestBoundaryViolation(reviewed, get(attachmentUrl(attachmentId(length))))).toBeNull();
});

test("the long identifier class keeps host, method, path and charset closed", () => {
  const reviewed = boundary("long_identifier");
  const id = attachmentId(600);
  const kinds = (request: ReturnType<typeof get>) =>
    requestBoundaryViolation(reviewed, request)?.kind;
  expect(kinds(get(attachmentUrl(id, MESSAGE_ID, "https://evil.example.test")))).toBe("target");
  expect(kinds(get(attachmentUrl(id), "DELETE"))).toBe("method");
  expect(kinds(get(`${attachmentUrl(id)}/extra`))).toBe("target");
  expect(kinds(get(`${GMAIL}/gmail/v1/users/me/messages/${MESSAGE_ID}/attachments`))).toBe(
    "target",
  );
  for (const bad of [`${id}.pdf`, `${id}%2F..`, "..", `${id}~`, attachmentId(1025)])
    expect(kinds(get(attachmentUrl(bad)))).toBe("target");
});

test("an approved identifier rule keeps its 200 character meaning", () => {
  expect(VALUE_CLASSES.identifier.test(attachmentId(200))).toBe(true);
  expect(VALUE_CLASSES.identifier.test(attachmentId(201))).toBe(false);
  const reviewed = boundary("identifier");
  expect(requestBoundaryViolation(reviewed, get(attachmentUrl(attachmentId(300))))?.kind).toBe(
    "target",
  );
});

test("a refused long id names the variable and the class that fits it", () => {
  const violation = requestBoundaryViolation(
    boundary("identifier"),
    get(attachmentUrl(attachmentId(712))),
  );
  expect(violation).toMatchObject({
    kind: "target",
    variable: {
      name: "item.attachmentId",
      length: 712,
      rule: "class identifier",
      fits_class: "long_identifier",
    },
  });
  const text = describeRequestBoundaryViolation(violation!);
  expect(text).toContain("`item.attachmentId` is 712 characters");
  expect(text).toContain('{class: "long_identifier"}');
});

test("a proposal for long observed ids picks the long identifier class", () => {
  const values = [attachmentId(420), attachmentId(512).split("").reverse().join("")];
  expect(proposedRule(values, VALUE_CLASSES, false, () => false)).toEqual({
    class: "long_identifier",
  });
  expect(proposedRule(["abc_def-1".repeat(5)], VALUE_CLASSES, false, () => false)).toEqual({
    class: "identifier",
  });
});
