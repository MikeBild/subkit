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

function refusal(run: () => unknown): { code: string; message: string; name: string } | null {
  try {
    run();
    return null;
  } catch (err) {
    if (!(err instanceof SftpRefusal)) throw err;
    return { code: err.code, message: err.message, name: err.name };
  }
}

describe("SFTP refusals say what to fix", () => {
  const ADDRESS_SHAPE = "the connector address must be sftp://host[:port]/folder";
  const ADDRESS_PARTS =
    "the connector address carries only host, port and folder; credentials belong in the stored credential";

  test("a refusal is an Error named SftpRefusal", () => {
    const refused = refusal(() => parseSftpAddress("https://files.example.com"));
    expect(refused?.name).toBe("SftpRefusal");
    expect(new SftpRefusal("sftp_address_invalid", "m")).toBeInstanceOf(Error);
  });

  test("a missing, unparsable or non-sftp address names the expected shape", () => {
    for (const address of [undefined, null, "", "not a url", "https://files.example.com"]) {
      expect({ address, refused: refusal(() => parseSftpAddress(address)) }).toEqual({
        address,
        refused: { code: "sftp_address_invalid", message: ADDRESS_SHAPE, name: "SftpRefusal" },
      });
    }
  });

  test("an address without a host is refused", () => {
    for (const address of ["sftp://", "sftp:///inbox"]) {
      expect({ address, refused: refusal(() => parseSftpAddress(address)) }).toEqual({
        address,
        refused: { code: "sftp_address_invalid", message: ADDRESS_SHAPE, name: "SftpRefusal" },
      });
    }
  });

  test("a username, password, query or fragment is refused on its own", () => {
    for (const address of [
      "sftp://deploy@files.example.com/inbox",
      "sftp://:secret@files.example.com/inbox",
      "sftp://files.example.com/inbox?mode=fast",
      "sftp://files.example.com/inbox#top",
    ]) {
      expect({ address, refused: refusal(() => parseSftpAddress(address)) }).toEqual({
        address,
        refused: { code: "sftp_address_invalid", message: ADDRESS_PARTS, name: "SftpRefusal" },
      });
    }
  });

  test("a NUL byte in the folder is refused with its message", () => {
    const expected = {
      code: "sftp_path_invalid",
      message: "the path contains a NUL byte",
      name: "SftpRefusal",
    };
    expect(refusal(() => parseSftpAddress("sftp://files.example.com/a%00b"))).toEqual(expected);
    expect(refusal(() => resolveSftpPath("/inbox", "a\0b"))).toEqual(expected);
  });

  test("dot-dot segments are refused with their message", () => {
    const expected = {
      code: "sftp_path_outside_root",
      message: "the path must not contain `..` segments",
      name: "SftpRefusal",
    };
    expect(refusal(() => resolveSftpPath("/inbox", "../x"))).toEqual(expected);
  });

  test("DELETE refuses a body with its message, also an empty string", () => {
    const expected = {
      code: "sftp_delete_body_refused",
      message:
        "sftp DELETE does not accept a body — remove one file per request (for_each with sftp.path)",
      name: "SftpRefusal",
    };
    expect(refusal(() => assertRemovableSftpFile("/inbox/a.csv", "x"))).toEqual(expected);
    expect(refusal(() => assertRemovableSftpFile("/inbox/a.csv", ""))).toEqual(expected);
    expect(refusal(() => assertRemovableSftpFile("/inbox/a.csv", {}))).toEqual(expected);
  });

  test("DELETE refuses an empty, root or folder path and names it", () => {
    for (const path of ["", "/", "/inbox/", "/inbox/reports/"]) {
      expect({ path, refused: refusal(() => assertRemovableSftpFile(path, undefined)) }).toEqual({
        path,
        refused: {
          code: "sftp_delete_not_a_file",
          message: `sftp DELETE path "${path}" is a folder, not a file`,
          name: "SftpRefusal",
        },
      });
    }
  });

  test("a null body is no body", () => {
    expect(refusal(() => assertRemovableSftpFile("/inbox/a.csv", null))).toBeNull();
  });
});

describe("SFTP path normalization", () => {
  test("a dot segment and empty segments vanish", () => {
    expect(resolveSftpPath("/inbox", "a/./b")).toBe("/inbox/a/b");
    expect(resolveSftpPath("/inbox", "./a//b/.")).toBe("/inbox/a/b");
    expect(parseSftpAddress("sftp://files.example.com/./in//box/").root).toBe("/in/box");
  });

  test("an address path is percent-decoded", () => {
    expect(parseSftpAddress("sftp://files.example.com/in%20box").root).toBe("/in box");
  });
});

describe("host key pin normalization", () => {
  test("only trailing padding is stripped and the prefix is added once", () => {
    expect(normalizeHostKeyPin("a=b==")).toBe("SHA256:a=b");
    expect(normalizeHostKeyPin("SHA256:abc=")).toBe("SHA256:abc");
    expect(normalizeHostKeyPin("abc")).toBe("SHA256:abc");
  });
});

test("PUT and DELETE write, LIST and GET read", () => {
  expect(sftpMethodWrites("PUT")).toBe(true);
  expect(sftpMethodWrites("DELETE")).toBe(true);
  expect(sftpMethodWrites("LIST")).toBe(false);
  expect(sftpMethodWrites("GET")).toBe(false);
});
