import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertRemovableSftpFile,
  normalizeHostKeyPin,
  parseSftpAddress,
  resolveSftpPath,
  SftpRefusal,
  sftpHostKeyFingerprint,
  sftpHostKeyMatches,
  sftpMethodWrites,
} from "./sftp.ts";

function refusalCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (err) {
    return err instanceof SftpRefusal ? err.code : "other";
  }
}

describe("parseSftpAddress", () => {
  test("reads host, port and root folder", () => {
    expect(parseSftpAddress("sftp://files.example.com:2222/inbox/")).toEqual({
      host: "files.example.com",
      port: 2222,
      root: "/inbox",
    });
    expect(parseSftpAddress("sftp://files.example.com")).toEqual({
      host: "files.example.com",
      port: 22,
      root: "/",
    });
  });

  test("refuses other schemes, credentials in the address and dot segments", () => {
    expect(refusalCode(() => parseSftpAddress("https://files.example.com"))).toBe(
      "sftp_address_invalid",
    );
    expect(refusalCode(() => parseSftpAddress("sftp://user:pw@files.example.com"))).toBe(
      "sftp_address_invalid",
    );
    expect(refusalCode(() => parseSftpAddress(null))).toBe("sftp_address_invalid");
  });
});

describe("resolveSftpPath", () => {
  test("joins the step path below the root", () => {
    expect(resolveSftpPath("/inbox", "reports/a.csv")).toBe("/inbox/reports/a.csv");
    expect(resolveSftpPath("/inbox", "/reports//a.csv")).toBe("/inbox/reports/a.csv");
    expect(resolveSftpPath("/", "a.csv")).toBe("/a.csv");
    expect(resolveSftpPath("/inbox", "/")).toBe("/inbox");
  });

  test("never leaves the root", () => {
    expect(refusalCode(() => resolveSftpPath("/inbox", "../etc/passwd"))).toBe(
      "sftp_path_outside_root",
    );
    expect(refusalCode(() => resolveSftpPath("/inbox", "a/../../b"))).toBe(
      "sftp_path_outside_root",
    );
    expect(refusalCode(() => resolveSftpPath("/inbox", "a\0b"))).toBe("sftp_path_invalid");
  });
});

describe("assertRemovableSftpFile", () => {
  test("a file without a body is removable", () => {
    expect(refusalCode(() => assertRemovableSftpFile("/inbox/a.csv", undefined))).toBeNull();
  });

  test("a body or a folder is refused", () => {
    expect(refusalCode(() => assertRemovableSftpFile("/inbox/a.csv", "x"))).toBe(
      "sftp_delete_body_refused",
    );
    expect(refusalCode(() => assertRemovableSftpFile("/", undefined))).toBe(
      "sftp_delete_not_a_file",
    );
  });
});

describe("host key pinning", () => {
  const key = new Uint8Array([1, 2, 3, 4]);
  const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

  test("the fingerprint has the ssh-keygen shape", () => {
    expect(sftpHostKeyFingerprint(key)).toBe(`SHA256:${digest}`);
  });

  test("a pin matches with or without the prefix and padding", () => {
    expect(sftpHostKeyMatches(`SHA256:${digest}`, key)).toBe(true);
    expect(sftpHostKeyMatches(`${digest}=`, key)).toBe(true);
    expect(normalizeHostKeyPin(` ${digest} `)).toBe(`SHA256:${digest}`);
  });

  test("a missing or different pin never matches", () => {
    expect(sftpHostKeyMatches(null, key)).toBe(false);
    expect(sftpHostKeyMatches("", key)).toBe(false);
    expect(sftpHostKeyMatches(`SHA256:${digest}`, new Uint8Array([9]))).toBe(false);
  });
});

test("PUT and DELETE write, LIST and GET read", () => {
  expect(sftpMethodWrites("PUT")).toBe(true);
  expect(sftpMethodWrites("DELETE")).toBe(true);
  expect(sftpMethodWrites("LIST")).toBe(false);
  expect(sftpMethodWrites("GET")).toBe(false);
});
