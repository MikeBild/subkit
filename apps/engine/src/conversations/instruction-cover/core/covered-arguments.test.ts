import { describe, expect, test } from "bun:test";
import { coveredArgumentsDigest, coveredArgumentsVerdict } from "./covered-arguments.ts";

const FILE_A = "file_11111111-2222-4333-8444-555555555555";
const FILE_B = "file_99999999-2222-4333-8444-555555555555";

function send(attachment: unknown) {
  return {
    connector: "mail",
    operation: "send_message",
    body: { to: "jane@example.test", subject: "Offer", attachments: [attachment] },
  };
}

describe("what runs is what was cleared to run", () => {
  test("the same arguments match, whatever the key order", () => {
    const covered = coveredArgumentsDigest(send({ $file: FILE_A }));
    expect(
      coveredArgumentsVerdict(covered, {
        operation: "send_message",
        body: { attachments: [{ $file: FILE_A }], subject: "Offer", to: "jane@example.test" },
        connector: "mail",
      }),
    ).toBe("same");
  });

  test("an attachment that now points at another file no longer matches", () => {
    const covered = coveredArgumentsDigest(send({ $file: FILE_A }));
    expect(coveredArgumentsVerdict(covered, send({ $file: FILE_B }))).toBe("changed");
  });

  test("an attachment still named by its handle is not the file that was cleared", () => {
    const covered = coveredArgumentsDigest(send({ $file: FILE_A }));
    expect(coveredArgumentsVerdict(covered, send({ $file: "@offer.pdf" }))).toBe("changed");
  });

  test("a part of an attachment is not the whole attachment", () => {
    const covered = coveredArgumentsDigest(send({ $file: FILE_A }));
    expect(coveredArgumentsVerdict(covered, send({ $file: FILE_A, $range: "1-2" }))).toBe(
      "changed",
    );
  });

  test("a changed recipient, text or order of a list no longer matches", () => {
    const base = send({ $file: FILE_A });
    const covered = coveredArgumentsDigest(base);
    expect(
      coveredArgumentsVerdict(covered, { ...base, body: { ...base.body, to: "eve@example.test" } }),
    ).toBe("changed");
    expect(
      coveredArgumentsVerdict(covered, { ...base, body: { ...base.body, subject: "Offer " } }),
    ).toBe("changed");
    const two = coveredArgumentsDigest({ to: ["a@example.test", "b@example.test"] });
    expect(coveredArgumentsVerdict(two, { to: ["b@example.test", "a@example.test"] })).toBe(
      "changed",
    );
  });

  test("a missing value and an absent key are the same arguments", () => {
    const covered = coveredArgumentsDigest({ connector: "mail", body: undefined });
    expect(coveredArgumentsVerdict(covered, { connector: "mail" })).toBe("same");
    expect(coveredArgumentsVerdict(covered, { connector: "mail", body: null })).toBe("changed");
  });

  test("a call that was asked about carries no binding", () => {
    expect(coveredArgumentsVerdict(undefined, send({ $file: FILE_B }))).toBe("unbound");
    expect(coveredArgumentsVerdict(null, send({ $file: FILE_B }))).toBe("unbound");
  });
});
