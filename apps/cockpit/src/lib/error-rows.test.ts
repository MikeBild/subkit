import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/transport";
import { translate } from "@/lib/i18n";
import { errorRows } from "./error-rows";

const de = (key: Parameters<typeof translate>[1]) => translate("de", key);

describe("technical rows of an error", () => {
  test("a request error shows its code, status and request ID, nothing else", () => {
    const error = new ApiError(429, { code: "rate_limited", message: "slow down" }, "req-7");
    expect(errorRows(error, de)).toEqual([
      ["Code", "rate_limited"],
      ["HTTP-Status", "429"],
      ["Anfrage-ID", "req-7"],
    ]);
  });

  test("missing facts leave their row out", () => {
    expect(errorRows(new ApiError(500, {}, null), de)).toEqual([["HTTP-Status", "500"]]);
    expect(errorRows(new Error("offline"), de)).toEqual([]);
    expect(errorRows(null, de)).toEqual([]);
  });
});
