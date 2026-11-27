import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { entryBody } from "./vault.ts";
import {
  maskedSummary,
  originsArg,
  promptStructuredValue,
  structuredValueFromJson,
} from "./vault-entries.ts";

function stdinOf(text: string, tty = false): NodeJS.ReadStream {
  const stream = Readable.from([Buffer.from(text)]) as unknown as NodeJS.ReadStream;
  Object.assign(stream, { isTTY: tty });
  return stream;
}

function scripted(answers: Record<string, string>) {
  const asked: Array<[string, "hidden" | "visible"]> = [];
  const answer = (mode: "hidden" | "visible") => async (label: string) => {
    asked.push([label, mode]);
    return answers[label] ?? "";
  };
  return { asked, prompts: { hidden: answer("hidden"), visible: answer("visible") } };
}

describe("entryBody", () => {
  test("a card asks for its number hidden and never for a security code", async () => {
    const { asked, prompts } = scripted({
      "Card number:": "4111 1111 1111 1111",
      "Expiry month (1-12):": "4",
      "Expiry year (e.g. 2030):": "2031",
      "Name on the card:": "Ada",
    });
    const body = await entryBody("card", {}, stdinOf("", true), prompts);
    expect(body).toEqual({
      value: { number: "4111 1111 1111 1111", exp_month: 4, exp_year: 2031, holder: "Ada" },
    });
    expect(asked[0]).toEqual(["Card number:", "hidden"]);
    expect(asked.map(([label]) => label).join(" ")).not.toMatch(/cvv|security/i);
  });

  test("a login reads password and one-time code key hidden, origins from the flag", async () => {
    const { asked, prompts } = scripted({
      "Password:": "pw",
      "One-time code key or otpauth:// link:": "JBSWY3DPEHPK3PXP",
    });
    const body = await entryBody(
      "login",
      { username: "ada", origins: "https://shop.example, https://www.shop.example", totp: true },
      stdinOf("", true),
      prompts,
    );
    expect(body).toEqual({
      username: "ada",
      password: "pw",
      totp_seed: "JBSWY3DPEHPK3PXP",
      origins: ["https://shop.example", "https://www.shop.example"],
    });
    expect(asked.every(([, mode]) => mode === "hidden")).toBe(true);
  });

  test("piped input: a login takes password and key on two lines, other kinds one JSON object", async () => {
    const prompts = scripted({}).prompts;
    expect(
      await entryBody("login", { username: "ada", totp: true }, stdinOf("pw\nSEED\n"), prompts),
    ).toEqual({ username: "ada", password: "pw", totp_seed: "SEED" });
    expect(await entryBody("note", {}, stdinOf('{"text":"door 1234","x":true}'), prompts)).toEqual({
      value: { text: "door 1234" },
    });
    await expect(
      entryBody("note", { origins: "https://x.example" }, stdinOf("{}"), prompts),
    ).rejects.toThrow("only a login");
  });
});

describe("helpers", () => {
  test("required fields must be answered, optional ones are skipped", async () => {
    await expect(promptStructuredValue("note", scripted({}).prompts)).rejects.toThrow("required");
    const value = await promptStructuredValue(
      "bank_account",
      scripted({ "IBAN:": "DE89370400440532013000", "Account holder:": "Ada" }).prompts,
    );
    expect(value).toEqual({ iban: "DE89370400440532013000", holder: "Ada" });
  });

  test("JSON input must be one object", () => {
    expect(() => structuredValueFromJson("[1]")).toThrow("one JSON object");
    expect(() => structuredValueFromJson("nope")).toThrow("one JSON object");
    expect(originsArg(undefined)).toBeUndefined();
  });

  test("the summary is masked per kind", () => {
    expect(
      maskedSummary({
        kind: "card",
        metadata: { brand: "visa", last4: "1111", exp_month: 4, exp_year: 2031 },
        origins: [],
      }),
    ).toBe("visa •••• 1111  04/2031");
    expect(
      maskedSummary({
        kind: "login",
        metadata: { username_hint: "ad…", has_totp: true },
        origins: ["https://shop.example"],
      }),
    ).toBe("ad…  one-time code  https://shop.example");
    expect(
      maskedSummary({
        kind: "bank_account",
        metadata: { iban_last4: "3000", country: "DE" },
        origins: [],
      }),
    ).toBe("DE •••• 3000");
    expect(maskedSummary({ kind: "secret", metadata: {}, origins: [] })).toBe("");
  });
});
