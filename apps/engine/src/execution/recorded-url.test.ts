import { expect, test } from "bun:test";
import { connectorMaskedQueryKeys, RECORDED_URL_MASK } from "../connectors/recorded-url.ts";
import { scrubRecordedUrls } from "./recorded-url.ts";
import { recordedUrl } from "./steps/request/drivers/http-exchange.ts";

test("a connector credential value never survives in a recorded address", () => {
  expect(recordedUrl("https://api.example.test/v1/items?tz=UTC&appid=s3cr3t", ["appid"])).toBe(
    "https://api.example.test/v1/items?tz=UTC&appid=***",
  );
  expect(
    recordedUrl(new URL("https://api.example.test/v1/items?appid=s3cr3t&appid=other"), ["appid"]),
  ).toBe("https://api.example.test/v1/items?appid=***");
  expect(recordedUrl("https://api.example.test/v1/items?tz=UTC", ["appid"])).toBe(
    "https://api.example.test/v1/items?tz=UTC",
  );
});

test("a well-known secret parameter is masked even when the connector did not add it", () => {
  expect(recordedUrl("https://api.example.test/v1?api_key=s3cr3t&page=2", [])).toBe(
    "https://api.example.test/v1?api_key=***&page=2",
  );
  expect(recordedUrl("https://user:s3cr3t@api.example.test/v1", [])).not.toContain("s3cr3t");
});

test("an address that cannot be read is recorded without its query", () => {
  expect(recordedUrl("not a url?appid=s3cr3t", ["appid"])).toBe("not a url");
});

test("stored step metadata is returned with every address scrubbed", () => {
  const stored = {
    request_meta: {
      driver: "http",
      url: "https://api.example.test/v1?api_key=s3cr3t&page=2",
      extras: { prepared: { url: "https://api.example.test/v1?token=s3cr3t" } },
    },
    error: { code: "http_4xx", resolved_url: "https://api.example.test/v1?access_token=s3cr3t" },
    pages: [{ url: "https://api.example.test/v1?key=s3cr3t" }, { url: 5 }, null],
    note: "url=https://api.example.test/v1?api_key=kept-as-text",
  };
  const shown = scrubRecordedUrls(stored);
  expect(JSON.stringify(shown)).not.toContain("s3cr3t");
  expect(shown.request_meta.url).toBe("https://api.example.test/v1?api_key=***&page=2");
  expect(shown.error.resolved_url).toBe("https://api.example.test/v1?access_token=***");
  expect(shown.pages[1]).toEqual({ url: 5 });
  expect(shown.note).toBe(stored.note);
  expect(stored.request_meta.url).toContain("s3cr3t");
});

test("values that hold no address pass through unchanged", () => {
  expect(scrubRecordedUrls(null)).toBeNull();
  expect(scrubRecordedUrls("plain")).toBe("plain");
  expect(scrubRecordedUrls({ url: null, held: true })).toEqual({ url: null, held: true });
  expect(scrubRecordedUrls({ url: "/relative?api_key=s3cr3t" })).toEqual({ url: "/relative" });
});

test("the keys to mask are the credential's query keys and the connector's static query keys", () => {
  expect(
    connectorMaskedQueryKeys(
      { static_query: { partner: "p", format: "json" } },
      { mode: "query", query: { appid: "s3cr3t" } },
    ),
  ).toEqual(["appid", "partner", "format"]);
  expect(connectorMaskedQueryKeys({ static_query: { partner: "p" } }, null)).toEqual(["partner"]);
  expect(connectorMaskedQueryKeys({}, { mode: "bearer", token: "s3cr3t" })).toEqual([]);
  expect(connectorMaskedQueryKeys(null, undefined)).toEqual([]);
  expect(connectorMaskedQueryKeys({ static_query: [] }, null)).toEqual([]);
  expect(
    recordedUrl(
      "https://api.example.test/graphql?appid=s3cr3t&partner=p&page=2",
      connectorMaskedQueryKeys(
        { static_query: { partner: "p" } },
        { mode: "query", query: { appid: "s3cr3t" } },
      ),
    ),
  ).toBe(
    `https://api.example.test/graphql?appid=${RECORDED_URL_MASK}&partner=${RECORDED_URL_MASK}&page=2`,
  );
});
