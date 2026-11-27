import { describe, expect, test } from "bun:test";
import { CSV_IMPORT_MAX_ROWS, detectFormat, parseCsv, parseLoginCsv } from "./csv-import.ts";

const NOW = new Date("2026-11-27T00:00:00Z");

describe("parseCsv", () => {
  test("handles quotes, escaped quotes, commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  test("keeps line breaks inside quoted cells and drops a BOM", () => {
    expect(parseCsv('﻿note\n"line 1\nline 2"')).toEqual([["note"], ["line 1\nline 2"]]);
  });
});

describe("detectFormat", () => {
  test("knows Chrome, 1Password and Bitwarden headers", () => {
    expect(detectFormat(["name", "url", "username", "password", "note"])).toBe("chrome");
    expect(detectFormat(["Title", "Url", "Username", "Password", "OTPAuth"])).toBe("1password");
    expect(
      detectFormat(["folder", "type", "name", "login_uri", "login_username", "login_password"]),
    ).toBe("bitwarden");
    expect(detectFormat(["foo", "bar"])).toBeNull();
  });
});

describe("parseLoginCsv", () => {
  test("Chrome rows become logins with their https origin", () => {
    const parsed = parseLoginCsv(
      "name,url,username,password,note\nShop,https://shop.example/login,ada,pw1,hello\n",
      undefined,
      NOW,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.format).toBe("chrome");
    expect(parsed.logins).toEqual([
      {
        row: 2,
        name: "shop",
        origin: "https://shop.example",
        website_ignored: false,
        username: "ada",
        password: "pw1",
        note: "hello",
      },
    ]);
  });

  test("1Password rows carry their otpauth key; http websites are left out", () => {
    const parsed = parseLoginCsv(
      [
        "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
        "Bank,https://bank.example,ada,pw,otpauth://totp/Bank:ada?secret=JBSWY3DPEHPK3PXP,,,,",
        "Old,http://old.example,bob,pw2,,,,,",
      ].join("\n"),
      undefined,
      NOW,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.logins.map((login) => [login.name, login.totp_seed, login.origin])).toEqual([
      ["bank", "JBSWY3DPEHPK3PXP", "https://bank.example"],
      ["old", undefined, null],
    ]);
    expect(parsed.logins[1]?.website_ignored).toBe(true);
  });

  test("Bitwarden skips notes and cards, rejects rows without a password and dedupes names", () => {
    const parsed = parseLoginCsv(
      [
        "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
        ",,login,Mail,,,,https://mail.example,ada,pw,JBSWY3DPEHPK3PXP",
        ",,login,Mail,,,,https://mail2.example,ada,pw,",
        ",,note,Secret note,text,,,,,,",
        ",,login,Empty,,,,https://e.example,ada,,",
      ].join("\n"),
      undefined,
      NOW,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.logins.map((login) => login.name)).toEqual(["mail", "mail-2"]);
    expect(parsed.logins[0]?.totp_seed).toBe("JBSWY3DPEHPK3PXP");
    expect(parsed.rejected.map((row) => [row.row, row.title])).toEqual([
      [4, "Secret note"],
      [5, "Empty"],
    ]);
  });

  test("an unknown or empty file is an error", () => {
    expect(parseLoginCsv("", undefined, NOW)).toEqual({ error: "the file is empty" });
    expect(parseLoginCsv("a,b\n1,2", undefined, NOW)).toMatchObject({
      error: expect.stringContaining("Chrome"),
    });
  });

  test("a row without a title is named after its website, or after its row", () => {
    const parsed = parseLoginCsv(
      ["name,url,username,password", ",https://www.shop.example/login,ada,pw1", ",,bob,pw2"].join(
        "\n",
      ),
      undefined,
      NOW,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.logins.map((login) => [login.name, login.origin])).toEqual([
      ["shop-example", "https://www.shop.example"],
      ["login-3", null],
    ]);
  });

  test("a file above the row limit is refused before any row is read", () => {
    const header = "name,url,username,password\n";
    const atLimit = parseLoginCsv(
      header + "Shop,,ada,pw\n".repeat(CSV_IMPORT_MAX_ROWS),
      undefined,
      NOW,
    );
    expect("error" in atLimit).toBe(false);
    expect(
      parseLoginCsv(header + "Shop,,ada,pw\n".repeat(CSV_IMPORT_MAX_ROWS + 1), undefined, NOW),
    ).toEqual({ error: `the file has more than ${CSV_IMPORT_MAX_ROWS} rows` });
  });

  test("a chosen format needs its password column", () => {
    expect(parseLoginCsv("name,url,username,password\nShop,,ada,pw", "bitwarden", NOW)).toEqual({
      error: "the bitwarden export needs a login_password column",
    });
  });
});
