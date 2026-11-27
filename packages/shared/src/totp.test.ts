import { describe, expect, test } from "bun:test";
import { base32Decode, isBase32Seed, parseOtpauth, totpCode, totpSeedFrom } from "./totp.ts";

const SHA1_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SHA256_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const SHA512_SEED =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

const RFC6238: ReadonlyArray<readonly [number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("totpCode", () => {
  test("matches every RFC 6238 test vector for SHA1, SHA256 and SHA512", () => {
    for (const [seconds, sha1, sha256, sha512] of RFC6238) {
      const at = seconds * 1000;
      expect(totpCode(SHA1_SEED, at, { digits: 8 })).toBe(sha1);
      expect(totpCode(SHA256_SEED, at, { digits: 8, algorithm: "SHA256" })).toBe(sha256);
      expect(totpCode(SHA512_SEED, at, { digits: 8, algorithm: "SHA512" })).toBe(sha512);
    }
  });

  test("defaults to six digits and a 30 second period", () => {
    expect(totpCode(SHA1_SEED, 59_000)).toBe("287082");
    expect(totpCode(SHA1_SEED, 30_000)).toBe(totpCode(SHA1_SEED, 59_999));
    expect(totpCode(SHA1_SEED, 60_000)).not.toBe(totpCode(SHA1_SEED, 59_999));
  });
});

describe("base32", () => {
  test("decodes the RFC seed to its ASCII key and ignores spaces, dashes and padding", () => {
    expect(Buffer.from(base32Decode(SHA1_SEED)).toString("utf8")).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv-gy3t qojq====")).toEqual(base32Decode("GEZDGNBVGY3TQOJQ"));
  });

  test("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("GEZD1")).toThrow("base32");
    expect(isBase32Seed("JBSWY3DPEHPK3PXP")).toBe(true);
    expect(isBase32Seed("short")).toBe(false);
  });
});

describe("otpauth", () => {
  test("reads secret, issuer, account and parameters", () => {
    expect(
      parseOtpauth(
        "otpauth://totp/Shop:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Shop&digits=8&period=60&algorithm=SHA256",
      ),
    ).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      digits: 8,
      period: 60,
      algorithm: "SHA256",
      issuer: "Shop",
      account: "ada@example.com",
    });
  });

  test("refuses hotp links, missing secrets and odd parameters", () => {
    expect(parseOtpauth("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP")).toBeNull();
    expect(parseOtpauth("otpauth://totp/x")).toBeNull();
    expect(parseOtpauth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4")).toBeNull();
    expect(parseOtpauth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toBeNull();
    expect(parseOtpauth("not a url")).toBeNull();
  });

  test("a stored seed comes from a base32 seed or a default otpauth link", () => {
    expect(totpSeedFrom(" jbsw y3dp ehpk 3pxp ")).toBe("JBSWY3DPEHPK3PXP");
    expect(totpSeedFrom("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP")).toBe("JBSWY3DPEHPK3PXP");
    expect(totpSeedFrom("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8")).toBeNull();
    expect(totpSeedFrom("123456")).toBeNull();
  });
});
