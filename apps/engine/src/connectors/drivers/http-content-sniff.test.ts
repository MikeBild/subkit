// Magic-byte sniffer for HTTP response bodies. Real-world APIs return
// JSON with `Content-Type: application/octet-stream` (some S3-compatible
// proxies), `text/plain` (some legacy gateways), or no header at all.
// The trusted-header fast path stays unchanged; sniffing only kicks in
// when the header is uninformative.

import { describe, expect, test } from "bun:test";

import { parseResponseBody, serializeXmlBody } from "./http.ts";

describe("parseResponseBody · trusted-header fast path", () => {
  test("application/json with valid body parses to object", () => {
    expect(parseResponseBody('{"a":1}', "application/json")).toEqual({ a: 1 });
  });

  test("application/json with charset parses correctly", () => {
    expect(parseResponseBody('{"a":1}', "application/json; charset=utf-8")).toEqual({ a: 1 });
  });

  test("application/json with malformed body falls back to text", () => {
    expect(parseResponseBody("not-json", "application/json")).toBe("not-json");
  });

  test("text/html stays as text (sniff doesn't auto-parse HTML)", () => {
    const html = "<html><body>hi</body></html>";
    expect(parseResponseBody(html, "text/html")).toBe(html);
  });
});

describe("parseResponseBody · sniff path · JSON", () => {
  test("application/octet-stream + JSON object body sniffs as JSON", () => {
    expect(parseResponseBody('{"key":"value"}', "application/octet-stream")).toEqual({
      key: "value",
    });
  });

  test("application/octet-stream + JSON array body sniffs as JSON", () => {
    expect(parseResponseBody("[1,2,3]", "application/octet-stream")).toEqual([1, 2, 3]);
  });

  test("text/plain + JSON body sniffs as JSON", () => {
    expect(parseResponseBody('{"x":1}', "text/plain")).toEqual({ x: 1 });
  });

  test("text/plain with charset suffix + JSON body sniffs as JSON", () => {
    expect(parseResponseBody('{"x":1}', "text/plain; charset=utf-8")).toEqual({ x: 1 });
  });

  test("missing content-type + JSON body sniffs as JSON", () => {
    expect(parseResponseBody('{"x":1}', "")).toEqual({ x: 1 });
  });

  test("leading whitespace before JSON still sniffs", () => {
    expect(parseResponseBody('   \n  {"a":1}', "")).toEqual({ a: 1 });
  });

  test("malformed JSON body falls back to text even with sniff", () => {
    expect(parseResponseBody("{not-json", "application/octet-stream")).toBe("{not-json");
  });
});

describe("parseResponseBody · sniff path · non-JSON", () => {
  test("CSV-shaped body without JSON header parses to row objects", () => {
    const csv = "name,email\nalice,a@x\nbob,b@y";
    expect(parseResponseBody(csv, "")).toEqual([
      { name: "alice", email: "a@x" },
      { name: "bob", email: "b@y" },
    ]);
  });

  test("CSV with quoted fields containing commas + escaped quotes", () => {
    const csv = 'a,b\n"x,y","he said ""hi"""\n';
    expect(parseResponseBody(csv, "application/octet-stream")).toEqual([
      { a: "x,y", b: 'he said "hi"' },
    ]);
  });

  test("XML-shaped body without JSON header parses to a tree", () => {
    const xml = '<?xml version="1.0"?><root><a>1</a><a>2</a></root>';
    expect(parseResponseBody(xml, "application/octet-stream")).toEqual({
      root: { a: ["1", "2"] },
    });
  });

  test("XML attributes prefix with @, repeated children collapse to arrays", () => {
    const xml = '<list><item id="a">first</item><item id="b">second</item></list>';
    expect(parseResponseBody(xml, "")).toEqual({
      list: {
        item: [
          { "@id": "a", "#text": "first" },
          { "@id": "b", "#text": "second" },
        ],
      },
    });
  });

  test("XML namespace prefix stays in the key", () => {
    const xml =
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ok/></soap:Body></soap:Envelope>';
    const out = parseResponseBody(xml, "application/octet-stream") as Record<string, unknown>;
    const env = out["soap:Envelope"] as Record<string, unknown>;
    expect(env["@xmlns:soap"]).toBe("http://schemas.xmlsoap.org/soap/envelope/");
    expect(env["soap:Body"]).toBeDefined();
  });

  test("self-closing element becomes null", () => {
    expect(parseResponseBody("<root><empty/></root>", "")).toEqual({
      root: { empty: null },
    });
  });

  test("CDATA segments concatenate into #text", () => {
    const xml = "<root><msg><![CDATA[hello & <world>]]></msg></root>";
    expect(parseResponseBody(xml, "application/octet-stream")).toEqual({
      root: { msg: "hello & <world>" },
    });
  });

  test("malformed XML falls back to text", () => {
    const xml = "<root><unclosed>";
    expect(parseResponseBody(xml, "application/octet-stream")).toBe(xml);
  });

  test("plain prose body returns text", () => {
    expect(parseResponseBody("just some prose, nothing structured", "text/plain")).toBe(
      "just some prose, nothing structured",
    );
  });

  test("empty body returns empty string", () => {
    expect(parseResponseBody("", "")).toBe("");
    expect(parseResponseBody("", "application/octet-stream")).toBe("");
  });
});

describe("parseResponseBody · false-positive guards", () => {
  test("HTML response with text/html header is NOT sniffed", () => {
    // Header is informative — text/html is not a sniff candidate, so
    // even an HTML body that contains a stray `{` is left as text.
    const html = "<html>{ not actually json }</html>";
    expect(parseResponseBody(html, "text/html")).toBe(html);
  });

  test("binary-like body with octet-stream header stays as text when not JSON-shaped", () => {
    const blob = "PNG\x00\x00\x00fake";
    expect(parseResponseBody(blob, "application/octet-stream")).toBe(blob);
  });
});

describe("serializeXmlBody · symmetric round-trip", () => {
  test("simple element with text content", () => {
    expect(serializeXmlBody({ greeting: "hi" })).toBe("<greeting>hi</greeting>");
  });

  test("attributes prefix with @, text with #text", () => {
    const tree = { item: { "@id": "1", "#text": "hello" } };
    expect(serializeXmlBody(tree)).toBe('<item id="1">hello</item>');
  });

  test("array children render as repeated elements", () => {
    const tree = { list: { item: [{ "@id": "a" }, { "@id": "b" }] } };
    expect(serializeXmlBody(tree)).toBe('<list><item id="a"/><item id="b"/></list>');
  });

  test("self-closing on null nodes", () => {
    expect(serializeXmlBody({ root: { empty: null } })).toBe("<root><empty/></root>");
  });

  test("entities escape into the rendered output", () => {
    const tree = { msg: 'a < b & "c"' };
    expect(serializeXmlBody(tree)).toBe('<msg>a &lt; b &amp; "c"</msg>');
  });
});
