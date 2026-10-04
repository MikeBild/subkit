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
/** The accepted inspection, or null when the profile refused the message. */
const observed = (body: unknown) => {
  const inspection = inspectReportMessage(body);
  return inspection.ok ? inspection : null;
};
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
  expect(observed(mime())?.boundary).toEqual(boundary);
  expect(() =>
    assertReportDelivery(boundary, request(mime("", boundary.to, "Tomorrow's new report"))),
  ).not.toThrow();
});
test("built-in MIME helper reports retain their envelope and decode for review", async () => {
  const html = "<p>Größe → vollständig</p>".repeat(20);
  const result = await runJs<{ raw: string }>({
    code: "return sk.buildMimeMessage(input);",
    input: { from: boundary.from, to: boundary.to, subject: "Daily report", html },
    clock: null,
  });
  const body = { raw: result.output!.raw };
  expect(observed(body)).toEqual({ ok: true, boundary, subject: "Daily report", text: html });
  expect(() => assertReportDelivery(boundary, request(body))).not.toThrow();
  expect(() =>
    assertReportDelivery({ ...boundary, to: "other@example.test" }, request(body)),
  ).toThrow();
});
test("encoded report body rejects malformed bytes and never introduces recipients", () => {
  const header = "\r\nContent-Transfer-Encoding: base64";
  for (const text of ["%%%", "YQ", "YR==", "/w==", "YQ==\n", "YQ==\r\nBcc: hidden@example.test"])
    expect(observed(mime(header, boundary.to, text))).toBeNull();
  const text = "Bcc: hidden@example.test\r\nContent-Type: multipart/mixed";
  const body = mime(header, boundary.to, Buffer.from(text).toString("base64"));
  expect(observed(body)?.text).toBe(text);
  expect(observed(body)?.boundary).toEqual(boundary);
  expect(observed(mime(`${header}\r\nBcc: hidden@example.test`, boundary.to, "YQ=="))).toBeNull();
});
test("recipient injection, unsupported MIME and extra payload options fail closed", () => {
  for (const [headers, reason] of [
    ["\r\nBcc: hidden@example.test", "header_not_allowed"],
    ["\r\nCc: other@example.test", "header_not_allowed"],
    ["\r\nTo: other@example.test", "header_duplicate"],
    ["\r\nResent-To: other@example.test", "header_not_allowed"],
    ["\r\nReply-To: other@example.test", "header_not_allowed"],
    ["\r\nContent-Type: multipart/mixed; boundary=x", "header_duplicate"],
    ["\r\n continuation", "header_folded"],
    ["\nBcc: hidden@example.test", "header_control_byte"],
    ["\r\nX-Test: abc", "header_not_allowed"],
  ] as const) {
    expect(inspectReportMessage(mime(headers))).toEqual({ ok: false, reason });
    expect(() => assertReportDelivery(boundary, request(mime(headers)))).toThrow(
      expect.objectContaining({ code: "execution_authority_changed", reason }),
    );
  }
  expect(() => assertReportDelivery(boundary, request(mime("", "other@example.test")))).toThrow(
    expect.objectContaining({ code: "execution_authority_changed", reason: "recipient_differs" }),
  );
  expect(inspectReportMessage({ ...mime(), threadId: "other-thread" })).toEqual({
    ok: false,
    reason: "not_json_raw",
  });
  expect(inspectReportMessage({ raw: "%%%" })).toEqual({ ok: false, reason: "not_base64url" });
  expect(() =>
    assertReportDelivery(boundary, { ...request(mime()), url: `${GMAIL_SEND_TARGET}?extra=true` }),
  ).toThrow();
  expect(() =>
    assertReportDelivery(boundary, { ...request(mime()), url: "https://other.example.test/send" }),
  ).toThrow();
  expect(() =>
    assertReportDelivery({ ...boundary, from: "other@example.test" }, request(mime())),
  ).toThrow(expect.objectContaining({ reason: "sender_differs" }));
  expect(() =>
    assertReportDelivery({ ...boundary, content_type: "text/plain" }, request(mime())),
  ).toThrow(expect.objectContaining({ reason: "content_type_differs" }));
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

test("Unicode report MIME uses the UTF-8 encoder; byte truncation is rejected", async () => {
  const text =
    "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Größe – Bericht\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\nMesswerte → vollständig";
  const correct = await runJs<string>({
    code: "return sk.base64UrlEncodeUtf8(input.text);",
    input: { text },
    clock: null,
  });
  expect(observed({ raw: correct.output })?.boundary).toEqual(boundary);
  const truncated = await runJs<string>({
    code: "return sk.base64UrlEncode(input.text);",
    input: { text },
    clock: null,
  });
  expect(observed({ raw: truncated.output })).toBeNull();
});

// ── The report profile, case by case ──────────────────────────────────────

const encode = (message: string) => ({ raw: Buffer.from(message).toString("base64url") });
const envelope = (fields: string[], body: string) =>
  encode(`${fields.join("\r\n")}\r\n\r\n${body}`);
const fields = (overrides: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    From: "sender@example.test",
    To: "recipient@example.test",
    Subject: "Report",
    "MIME-Version": "1.0",
    "Content-Type": "text/html; charset=UTF-8",
    ...overrides,
  };
  return Object.entries(base).flatMap(([key, value]) =>
    value === null ? [] : [`${key}: ${value}`],
  );
};
const part = (type: string, content: string, extra: string[] = []) =>
  [
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    ...extra,
    "",
    Buffer.from(content).toString("base64"),
  ].join("\r\n");
const alternative = (parts: string[], tail = "\r\n", boundaryName = "b-1") =>
  envelope(
    fields({ "Content-Type": `multipart/alternative; boundary="${boundaryName}"` }),
    `${parts.map((p) => `--${boundaryName}\r\n${p}\r\n`).join("")}--${boundaryName}--${tail}`,
  );
const reasonOf = (body: unknown) => {
  const inspection = inspectReportMessage(body);
  return inspection.ok ? "ok" : inspection.reason;
};

test("a named mailbox is accepted and compared by its address alone", () => {
  for (const from of [
    "Upraft Auth <sender@example.test>",
    "Ops-Team daily <sender@example.test>",
    "O'Brien & Sons+Co <sender@example.test>",
    // An encoded word is atext throughout; the name is shown, never compared.
    "=?UTF-8?B?w4Q=?= <sender@example.test>",
  ])
    expect(observed(envelope(fields({ From: from }), "x"))?.boundary.from).toBe(
      "sender@example.test",
    );
  expect(
    observed(envelope(fields({ To: "Name <recipient@example.test>" }), "x"))?.boundary,
  ).toEqual(boundary);
  for (const [from, reason] of [
    ['"Quoted Name" <sender@example.test>', "sender_invalid"],
    ["Doe, Jane <sender@example.test>", "sender_invalid"],
    ["<sender@example.test>", "sender_invalid"],
    ["Größe <sender@example.test>", "sender_invalid"],
    ["Name <sender@example.test> <other@example.test>", "sender_invalid"],
    ["sender@example.test, other@example.test", "sender_invalid"],
  ] as const)
    expect(reasonOf(envelope(fields({ From: from }), "x"))).toBe(reason);
  expect(
    reasonOf(envelope(fields({ To: "recipient@example.test, other@example.test" }), "x")),
  ).toBe("extra_recipients");
  expect(reasonOf(envelope(fields({ To: "Name <a@example.test>, b@example.test" }), "x"))).toBe(
    "extra_recipients",
  );
  expect(reasonOf(envelope(fields({ To: "not an address" }), "x"))).toBe("recipient_invalid");
});

test("an unquoted display name is atext and spaces only, so it cannot carry structure", () => {
  // Each of these names a mailbox besides the one in angle brackets, or
  // hides one in a comment: RFC 5322 group syntax, a comment, an address
  // in the name, an obsolete route, a quoted-pair, a dotted phrase.
  for (const to of [
    "Team: attacker@evil.example; <recipient@example.test>",
    "Team: <recipient@example.test>",
    "Team; <recipient@example.test>",
    "attacker@evil.example <recipient@example.test>",
    "Ops (attacker@evil.example) <recipient@example.test>",
    "Ops (daily) <recipient@example.test>",
    "Ops [x] <recipient@example.test>",
    "Ops\\ Team <recipient@example.test>",
    "Dr. Ops <recipient@example.test>",
    '"Team: attacker@evil.example;" <recipient@example.test>',
    '"Ops\\" <x@evil.example>" <recipient@example.test>',
    "Ops\tTeam <recipient@example.test>",
  ])
    expect([to, reasonOf(envelope(fields({ To: to }), "x"))]).toEqual([to, "recipient_invalid"]);
  for (const from of [
    "Team: attacker@evil.example; <sender@example.test>",
    "Ops (daily) <sender@example.test>",
  ])
    expect([from, reasonOf(envelope(fields({ From: from }), "x"))]).toEqual([
      from,
      "sender_invalid",
    ]);
  // The separator before the angle bracket may still be a tab.
  expect(
    observed(envelope(fields({ To: "Ops Team\t<recipient@example.test>" }), "x"))?.boundary,
  ).toEqual(boundary);
});

test("sk.buildMimeMessage keeps a display name ASCII, so every name it writes is reviewable", async () => {
  const build = async (from: string) =>
    runJs<{ raw: string }>({
      code: "return { raw: sk.buildMimeMessage(input).raw };",
      input: { from, to: boundary.to, subject: "Bericht – Größe", text: "x" },
      clock: null,
    });
  const named = await build("Upraft Auth <sender@example.test>");
  expect(observed(named.output!)?.boundary.from).toBe("sender@example.test");
  // A non-ASCII name is refused by the helper itself, never encoded into an
  // address field the review would have to decode.
  await expect(build("Größe <sender@example.test>")).rejects.toThrow("from must be ASCII");
});

test("a subject folds only into whole encoded words", () => {
  const words = ["=?UTF-8?B?w4Rnw7xp?=", "=?UTF-8?B?w7Zr?="];
  const folded = envelope(fields({ Subject: words.join("\r\n ") }), "x");
  expect(observed(folded)?.subject).toBe("Ägüiök");
  for (const subject of [
    "Report\r\n =?UTF-8?B?w7Zr?=",
    `${words[0]}\r\n continued text`,
    `${words[0]}\r\n\t${words[1]}`,
    `${words[0]}\r\n  ${words[1]}`,
  ])
    expect(reasonOf(envelope(fields({ Subject: subject }), "x"))).toBe("header_folded");
  // Folding anywhere else is refused, whatever it continues with.
  expect(reasonOf(envelope(fields({ To: `recipient@example.test\r\n ${words[0]}` }), "x"))).toBe(
    "header_folded",
  );
});

test("sk.buildMimeMessage reports pass in every shape the profile names", async () => {
  const build = async (input: Record<string, unknown>) =>
    (
      await runJs<{ raw: string }>({
        code: "return { raw: sk.buildMimeMessage(input).raw };",
        input,
        clock: null,
      })
    ).output!;
  const base = { from: "Upraft Auth <ops@example.test>", to: "ops@example.test" };
  const both = await build({
    ...base,
    subject: "Upraft Auth: login – Prüfung ok",
    html: "<p>Prüfung ok</p>",
    text: "Prüfung ok",
  });
  expect(inspectReportMessage(both)).toEqual({
    ok: true,
    boundary: {
      kind: "gmail_report",
      to: "ops@example.test",
      from: "ops@example.test",
      content_type: "multipart/alternative",
    },
    subject: "Upraft Auth: login – Prüfung ok",
    text: "<p>Prüfung ok</p>",
  });
  // A subject long enough to fold across several encoded words.
  const long = "Wöchentlicher Bericht — ".repeat(6);
  expect(observed(await build({ ...base, subject: long, text: "plain" }))?.subject).toBe(long);
  expect(
    observed(await build({ ...base, subject: "x", text: "plain" }))?.boundary.content_type,
  ).toBe("text/plain");
  // What buildMimeMessage can also emit stays outside the review.
  for (const [extra, reason] of [
    [{ cc: "cc@example.test" }, "header_not_allowed"],
    [{ bcc: "bcc@example.test" }, "header_not_allowed"],
    [{ replyTo: "reply@example.test" }, "header_not_allowed"],
    [{ headers: { "X-Report": "1" } }, "header_not_allowed"],
    [{ to: ["a@example.test", "b@example.test"] }, "extra_recipients"],
  ] as const)
    expect(reasonOf(await build({ ...base, subject: "x", html: "<p/>", ...extra }))).toBe(reason);
});

test("multipart/alternative is exactly text/plain then text/html, nothing more", () => {
  const plain = part("text/plain", "plain");
  const html = part("text/html", "<p>html</p>");
  expect(observed(alternative([plain, html]))?.text).toBe("<p>html</p>");
  expect(observed(alternative([plain, html], ""))?.boundary.content_type).toBe(
    "multipart/alternative",
  );
  for (const [body, reason] of [
    [alternative([html, plain]), "multipart_unsupported"],
    [alternative([plain]), "multipart_unsupported"],
    [alternative([plain, html, html]), "multipart_unsupported"],
    [alternative([plain, html], "\r\ntrailing epilogue\r\n"), "multipart_unsupported"],
    [alternative([plain, html], "\r\n\r\n"), "multipart_unsupported"],
    [
      alternative([
        plain,
        part("text/html", "<p/>", ['Content-Disposition: attachment; filename="a"']),
      ]),
      "multipart_unsupported",
    ],
    [alternative([plain, part("application/pdf", "%PDF")]), "content_type_unsupported"],
    [
      alternative([
        plain,
        'Content-Type: multipart/mixed; boundary="inner"\r\n\r\n--inner\r\n\r\nx\r\n--inner--',
      ]),
      "multipart_unsupported",
    ],
    [
      alternative([
        plain,
        "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n%%%",
      ]),
      "body_not_base64",
    ],
    [
      alternative([
        plain,
        "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nx",
      ]),
      "transfer_encoding_unsupported",
    ],
    [
      alternative([
        plain,
        "Content-Type: text/html; charset=UTF-8\r\nBcc: hidden@example.test\r\n\r\nx",
      ]),
      "multipart_unsupported",
    ],
    [
      envelope(
        fields({ "Content-Type": 'multipart/alternative; boundary="b-1"' }),
        `preamble\r\n--b-1\r\n${plain}\r\n--b-1\r\n${html}\r\n--b-1--`,
      ),
      "multipart_unsupported",
    ],
    [
      envelope(
        fields({ "Content-Type": 'multipart/mixed; boundary="b-1"' }),
        `--b-1\r\n${plain}\r\n--b-1--`,
      ),
      "multipart_unsupported",
    ],
    [
      envelope(
        [
          ...fields({ "Content-Type": 'multipart/alternative; boundary="b-1"' }),
          "Content-Transfer-Encoding: base64",
        ],
        `--b-1\r\n${plain}\r\n--b-1\r\n${html}\r\n--b-1--`,
      ),
      "transfer_encoding_unsupported",
    ],
  ] as const)
    expect(reasonOf(body)).toBe(reason);
});

test("each refusal names its own rule", () => {
  expect(reasonOf("not json")).toBe("not_json_raw");
  expect(reasonOf({ raw: 1 })).toBe("not_json_raw");
  expect(reasonOf({ raw: Buffer.from([0x46, 0xb7]).toString("base64url") })).toBe("not_utf8");
  expect(reasonOf(encode("From: sender@example.test"))).toBe("missing_headers");
  expect(reasonOf(envelope(fields({ Subject: null }), "x"))).toBe("missing_headers");
  expect(reasonOf(envelope(fields({ "MIME-Version": "2.0" }), "x"))).toBe("missing_headers");
  expect(reasonOf(envelope(fields({ "Content-Type": "application/pdf" }), "x"))).toBe(
    "content_type_unsupported",
  );
  expect(reasonOf(envelope(fields({ "Content-Type": "text/html; charset=ISO-8859-1" }), "x"))).toBe(
    "content_type_unsupported",
  );
  expect(
    reasonOf(envelope([...fields(), "Content-Transfer-Encoding: quoted-printable"], "x")),
  ).toBe("transfer_encoding_unsupported");
  expect(reasonOf(envelope([...fields(), "Content-Transfer-Encoding: base64"], "%%%"))).toBe(
    "body_not_base64",
  );
});

test("the byte-per-character encoder breaks a report in two different ways", async () => {
  // `—` (U+2014) keeps only its low byte 0x14, a control byte that still
  // decodes as UTF-8; `·` (U+00B7) keeps 0xB7, which is not UTF-8 at all. The
  // second is checked first, because the message is decoded before its
  // headers are read.
  const encodeBinary = async (message: string) =>
    (
      await runJs<string>({
        code: "return sk.base64UrlEncode(input.m);",
        input: { m: message },
        clock: null,
      })
    ).output;
  const header = (subject: string) =>
    `From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`;
  expect(reasonOf({ raw: await encodeBinary(`${header("a — b")}<p>ok</p>`) })).toBe(
    "header_control_byte",
  );
  expect(reasonOf({ raw: await encodeBinary(`${header("a — b")}<p>a · b</p>`) })).toBe("not_utf8");
});
