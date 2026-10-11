import { describe, expect, test } from "bun:test";
import { runJsInCurrentProcess } from "../../runtime.ts";

const execute = async (code: string) =>
  (await runJsInCurrentProcess({ code, input: null, clock: { now_ms: 0, seed: "tools-test" } }))
    .output;
describe("bounded sandbox tools", () => {
  test("exact decimals and explicit rounding", async () => {
    expect(
      await execute(
        'return [sk.money.add("0.1","0.2"),sk.money.div("1","8",2,"halfEven"),sk.money.round("1.255",2,"halfUp")];',
      ),
    ).toEqual(["0.3", "0.12", "1.26"]);
    await expect(execute('return sk.money.add(0.1,"0.2");')).rejects.toThrow();
  });
  test("CSV multiline and formula-safe export", async () => {
    expect(
      await execute('return sk.csv.parse("\\uFEFFname,value\\r\\nAda,\\"a\\nb\\"",{header:true});'),
    ).toEqual([{ name: "Ada", value: "a\nb" }]);
    expect(await execute('return sk.csv.stringify([["=1+1"]],{header:false});')).toContain("'=1+1");
  });
  test("DST ambiguity and date-only arithmetic", async () => {
    expect(await execute('return sk.date.add("2024-02-28",1,"days");')).toBe("2024-02-29");
    await expect(
      execute('return sk.date.parse("2024-10-27T02:30:00",{zone:"Europe/Berlin"});'),
    ).rejects.toThrow();
    expect(
      await execute(
        'return sk.date.parse("2024-10-27T02:30:00",{zone:"Europe/Berlin",disambiguation:"earlier"}).instant;',
      ),
    ).toBe("2024-10-27T00:30:00Z");
  });
  test("schema errors and remote ref denial", async () => {
    expect(await execute('return sk.schema.validate({type:"number"},"no").valid;')).toBe(false);
    await expect(
      execute('return sk.schema.validate({$ref:"https://example.invalid/schema"},{});'),
    ).rejects.toThrow();
  });
  test("WHATWG URLs preserve repeated Unicode query keys", async () => {
    expect(await execute('return sk.url.query("https://example.org/?x=1&x=%C3%A4");')).toEqual([
      ["x", "1"],
      ["x", "ä"],
    ]);
  });
  test("ordered XML mixed content and entity denial", async () => {
    expect(
      await execute(
        'return sk.xml.build(sk.xml.parse("<a z=\\"2\\" b=\\"1\\">Hello <b>world</b>!</a>"));',
      ),
    ).toBe('<a b="1" z="2">Hello <b>world</b>!</a>');
    await expect(execute('return sk.xml.parse("<!DOCTYPE a><a/>");')).rejects.toThrow();
  });
  test("escaped templates and stable keyed diffs", async () => {
    expect(
      await execute(
        'return sk.template.render("{{#items}}{{name}}{{/items}}",{items:[{name:"<b>"}]});',
      ),
    ).toBe("&lt;b&gt;");
    expect(
      await execute('return sk.diff.records([{id:1,n:"a"}],[{n:"a",id:1},{id:2}],{key:"id"});'),
    ).toEqual({ added: [{ id: 2 }], removed: [], updated: [] });
    await expect(
      execute('return sk.diff.records([],[{id:1},{id:1}],{key:"id"});'),
    ).rejects.toThrow();
  });
  test("ambiguous conversion, URL credentials and custom entities fail closed", async () => {
    await expect(
      execute('return sk.date.convertZone("2024-01-01T12:00:00","Europe/Berlin");'),
    ).rejects.toThrow();
    await expect(
      execute('return sk.url.parse("https://user:secret@example.org/");'),
    ).rejects.toThrow();
    await expect(
      execute(
        `return sk.xml.parse('<!DOCTYPE a [<!ENTITY evil SYSTEM "file:///etc/passwd">]><a>&evil;</a>');`,
      ),
    ).rejects.toThrow();
    expect(await execute('return sk.xml.build(sk.xml.parse("<a>&amp;&lt;</a>"));')).toBe(
      "<a>&amp;&lt;</a>",
    );
  });
  test("namespaces are immutable and host capabilities stay absent", async () => {
    expect(
      await execute(
        "return [Object.isFrozen(sk.money),typeof fetch,typeof process,typeof __sk_tools__,typeof __sk_helper_source__,typeof __sk_tool_value__];",
      ),
    ).toEqual([true, "undefined", "undefined", "undefined", "undefined", "undefined"]);
  });
});
