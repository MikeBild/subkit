import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REDACTED,
  findSecretSpans,
  redactKnownValues,
  redactPaymentData,
  redactSecretShapes,
  scrubString,
} from "../redaction.ts";

describe("card numbers", () => {
  test("Luhn-valid numbers are redacted plain, with spaces and with dashes", () => {
    for (const pan of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "3782 822463 10005",
      "5555555555554444",
    ]) {
      expect(scrubString(`pay with ${pan} now`)).toBe("pay with ***REDACTED:card*** now");
    }
  });

  test("numbers that fail Luhn or have no card brand stay", () => {
    expect(scrubString("order 4111111111111112")).toBe("order 4111111111111112");
    expect(scrubString("at 1795749871868 ms")).toBe("at 1795749871868 ms");
    expect(scrubString("id 1234567812345670")).toBe("id 1234567812345670");
  });

  test("digits inside a longer run are not cut out", () => {
    expect(scrubString("x41111111111111110000")).toBe("x41111111111111110000");
  });

  test("UUIDs whose digit groups pass Luhn stay", () => {
    for (const id of [
      "a11c49d8-fd15-4876-aa52-481428502446",
      "A11C49D8-FD15-4876-AA52-481428502446",
      "26508624-3195-49ff-83f2-c58bedfd3e8d",
      "4111e111-1111-1111-1111-111111111111",
      "00000000-4111-1111-1111-111111111111",
    ]) {
      expect(redactPaymentData(`run ${id} done`)).toBe(`run ${id} done`);
      expect(scrubString(`run ${id} done`)).toBe(`run ${id} done`);
      expect(findSecretSpans(id).filter((span) => span.kind === "card")).toEqual([]);
    }
  });

  test("UUIDs stay, a card next to them is still redacted", () => {
    const id = "a11c49d8-fd15-4876-aa52-481428502446";
    expect(redactPaymentData(`${id} 4111 1111 1111 1111`)).toBe(`${id} ***REDACTED:card***`);
  });

  test("long numeric ids that are not card numbers stay", () => {
    for (const id of [
      "order_4111111111111111",
      "inv-4111111111111111",
      "4111111111111111abc",
      "17327123456789012345",
      "1234567890123456789",
      "9007199254740993",
      "1795749871868",
    ]) {
      expect(redactPaymentData(`id ${id} ok`)).toBe(`id ${id} ok`);
    }
  });
});

describe("IBAN", () => {
  test("checksum-valid IBANs are redacted, grouped or not", () => {
    expect(scrubString("IBAN DE89 3704 0044 0532 0130 00.")).toBe("IBAN ***REDACTED:iban***.");
    expect(scrubString("to GB82WEST12345698765432")).toBe("to ***REDACTED:iban***");
  });

  test("a wrong checksum stays", () => {
    expect(scrubString("DE89370400440532013001")).toBe("DE89370400440532013001");
  });
});

describe("security codes and one-time codes", () => {
  test("a CVV or CVC next to its label is redacted, the label stays", () => {
    expect(redactPaymentData("CVV: 123")).toBe("CVV: ***REDACTED:cvv***");
    expect(redactPaymentData("cvc 4567")).toBe("cvc ***REDACTED:cvv***");
    expect(redactPaymentData("security code is 987")).toBe("security code is ***REDACTED:cvv***");
  });

  test("six to eight digits after a code label are redacted", () => {
    expect(redactPaymentData("Your code is 482913")).toBe("Your code is ***REDACTED:otp***");
    expect(redactPaymentData("OTP: 12345678")).toBe("OTP: ***REDACTED:otp***");
    expect(redactPaymentData("verification code 004211")).toBe(
      "verification code ***REDACTED:otp***",
    );
  });

  test("short status codes and unlabeled numbers stay", () => {
    expect(redactPaymentData("status code 404")).toBe("status code 404");
    expect(redactPaymentData("zipcode 123456")).toBe("zipcode 123456");
    expect(redactPaymentData("call 482913")).toBe("call 482913");
  });
});

describe("counting and spans", () => {
  test("redactSecretShapes counts payment data", () => {
    const result = redactSecretShapes("card 4111111111111111, code: 123456");
    expect(result.count).toBe(2);
    expect(result.text).toBe("card ***REDACTED:card***, code: ***REDACTED:otp***");
  });

  test("findSecretSpans reports card and IBAN spans", () => {
    const text = "4111 1111 1111 1111 and DE89370400440532013000";
    expect(findSecretSpans(text).map((span) => span.kind)).toEqual(["card", "iban"]);
  });
});

describe("redactKnownValues with card numbers", () => {
  test("a stored PAN is redacted in every spaced and dashed layout", () => {
    const pan = "4111111111111111";
    const text = "a 4111 1111 1111 1111 b 4111-1111-1111-1111 c 4111111111111111";
    expect(redactKnownValues(text, [pan])).toBe(
      `a ${DEFAULT_REDACTED} b ${DEFAULT_REDACTED} c ${DEFAULT_REDACTED}`,
    );
  });

  test("an Amex number is redacted in its 4-6-5 layout", () => {
    expect(redactKnownValues("x 3782 822463 10005", ["378282246310005"])).toBe(
      `x ${DEFAULT_REDACTED}`,
    );
  });

  test("a spaced stored value matches the plain digits too", () => {
    expect(redactKnownValues("n=4111111111111111", ["4111 1111 1111 1111"])).toBe(
      `n=${DEFAULT_REDACTED}`,
    );
  });

  test("non-card values get no extra variants", () => {
    expect(redactKnownValues("1234 5678", ["12345678"])).toBe("1234 5678");
  });
});
