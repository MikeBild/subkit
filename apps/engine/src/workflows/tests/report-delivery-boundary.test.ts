import { expect, test } from "bun:test";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import {
  assertReadQuery,
  assertReportDelivery,
  GMAIL_SEND_TARGET,
  inspectReportMessage,
} from "../report-delivery-boundary.ts";

const mime = (headers = "", to = "recipient@example.test", text = "Report") => ({
  raw: Buffer.from(
    `From: sender@example.test\r\nTo: ${to}\r\nSubject: Today's report\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8${headers}\r\n\r\n${text}`,
  ).toString("base64url"),
});
const boundary = {
  kind: "gmail_report" as const,
  to: "recipient@example.test",
  from: "sender@example.test",
  content_type: "text/html" as const,
};
const request = (body: unknown) => ({
  method: "POST",
  url: GMAIL_SEND_TARGET,
  headers: {},
  body: body as { raw: string },
});

test("changing report contents keeps the reviewed recipient and sender", () => {
  expect(inspectReportMessage(mime())?.boundary).toEqual(boundary);
  expect(() =>
    assertReportDelivery(boundary, request(mime("", boundary.to, "Tomorrow's new report"))),
  ).not.toThrow();
});
test("recipient injection, unsupported MIME and extra payload options fail closed", () => {
  for (const headers of [
    "\r\nBcc: hidden@example.test",
    "\r\nCc: other@example.test",
    "\r\nTo: other@example.test",
    "\r\nResent-To: other@example.test",
    "\r\nReply-To: other@example.test",
    "\r\nContent-Type: multipart/mixed; boundary=x",
    "\r\n continuation",
    "\nBcc: hidden@example.test",
    "\r\nX-Test: abc",
  ]) {
    expect(inspectReportMessage(mime(headers))).toBeNull();
    expect(() => assertReportDelivery(boundary, request(mime(headers)))).toThrow();
  }
  expect(() => assertReportDelivery(boundary, request(mime("", "other@example.test")))).toThrow();
  expect(inspectReportMessage({ ...mime(), threadId: "other-thread" })).toBeNull();
  expect(inspectReportMessage({ raw: "%%%" })).toBeNull();
  expect(inspectReportMessage(mime("", "Name <recipient@example.test>"))).toBeNull();
  expect(() =>
    assertReportDelivery(boundary, { ...request(mime()), url: `${GMAIL_SEND_TARGET}?extra=true` }),
  ).toThrow();
  expect(() =>
    assertReportDelivery(boundary, { ...request(mime()), url: "https://other.example.test/send" }),
  ).toThrow();
  expect(() =>
    assertReportDelivery({ ...boundary, from: "other@example.test" }, request(mime())),
  ).toThrow();
});
test("read queries may vary only their approved values, never fixed resources or endpoint", () => {
  const bounds = { fixed: { host_id: "fixed-host" }, variable: ["start", "end"] };
  const target = "https://example.test/metrics";
  const req = {
    method: "GET",
    url: `${target}?host_id=fixed-host&start=100&end=200`,
    headers: {},
    body: null,
  };
  expect(() => assertReadQuery(bounds, target, req)).not.toThrow();
  for (const url of [
    `${target}?host_id=other&start=100&end=200`,
    `${target}?host_id=fixed-host&start=100&end=200&end=300`,
    `${target}?host_id=fixed-host&start=100&end=200&extra=1`,
    `${target}/other?host_id=fixed-host&start=100&end=200`,
  ])
    expect(() => assertReadQuery(bounds, target, { ...req, url })).toThrow();
});

test("Unicode report MIME uses the UTF-8 encoder; legacy byte truncation is rejected", async () => {
  const text =
    "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Größe – Bericht\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\nMesswerte → vollständig";
  const correct = await runJs<string>({
    code: "return sk.base64UrlEncodeUtf8(input.text);",
    input: { text },
    clock: null,
  });
  expect(inspectReportMessage({ raw: correct.output })?.boundary).toEqual(boundary);
  const legacy = await runJs<string>({
    code: "return sk.base64UrlEncode(input.text);",
    input: { text },
    clock: null,
  });
  expect(inspectReportMessage({ raw: legacy.output })).toBeNull();
});
