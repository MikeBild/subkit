import { describe, expect, test } from "bun:test";
import { parseSource } from "../audit/imports.ts";
import { routeSchemaHits, toolSchemaHits } from "../audit/zod-boundaries.ts";

const routes = (text: string) => routeSchemaHits(parseSource("r.ts", text)).map((h) => h.what);
const tools = (text: string) => toolSchemaHits(parseSource("t.ts", text)).map((h) => h.line);

describe("routeSchemaHits", () => {
  test("accepts reads that match declared request entries", () => {
    const text = `
const r = createRoute({ method: "post", path: "/x/{id}", request: { params: P, query: Q, body: B } });
app.openapi(r, async (c) => {
  c.req.valid("param"); c.req.valid("query"); c.req.valid("json");
  c.req.param("id"); c.req.query("a"); await c.req.json();
});`;
    expect(routes(text)).toEqual([]);
  });

  test("flags validated and raw reads without a request entry", () => {
    const text = `
const r = createRoute({ method: "get", path: "/x/{id}" });
app.openapi(r, async (ctx) => {
  ctx.req.valid("param");
  ctx.req.query("a");
  ctx.req.queries("b");
  await ctx.req.parseBody();
  await ctx.req.formData();
  await ctx.req.text();
  ctx.req.valid("header");
  ctx.req.header("x");
  other.req.param("id");
});`;
    expect(routes(text)).toEqual([
      'ctx.req.valid("param") without request.params',
      "ctx.req.query() without request.query",
      "ctx.req.queries() without request.query",
      "ctx.req.parseBody() without request.body",
      "ctx.req.formData() without request.body",
      "ctx.req.text() without request.body",
    ]);
  });

  test("resolves inline routes, factories and the handler after a hook argument", () => {
    const text = `
function make(seg) { return createRoute({ method: "post", path: seg, request: { params: P } }); }
const made = make("a");
const arrow = () => createRoute({ method: "get", path: "/b", request: { query: Q } });
const viaArrow = arrow();
app.openapi(made, (c) => { c.req.param("id"); c.req.valid("json"); });
app.openapi(viaArrow, (c) => { c.req.query("q"); });
app.openapi(createRoute({ method: "get", path: "/c" }), async function (c) { c.req.valid("form"); }, hook);
`;
    expect(routes(text)).toEqual([
      'c.req.valid("json") without request.body',
      'c.req.valid("form") without request.body',
    ]);
  });

  test("falls back to the union of the file's routes for unresolved route expressions", () => {
    const text = `
const a = createRoute({ request: { params: P } });
for (const [route] of [[a]]) app.openapi(route, (c) => { c.req.param("id"); c.req.query("q"); });
app.openapi(routes.a, (c) => { c.req.param("id"); });
`;
    expect(routes(text)).toEqual(["c.req.query() without request.query"]);
  });

  test("treats spreads and non-literal request configs as declaring every part", () => {
    const text = `
const a = createRoute({ ...base });
const b = createRoute({ request: shared });
const d = createRoute({ request: { ...shared } });
const e = createRoute({ request });
const f = createRoute(config);
app.openapi(a, (c) => { c.req.query("q"); });
app.openapi(b, (c) => { c.req.query("q"); });
app.openapi(d, (c) => { c.req.query("q"); });
app.openapi(e, (c) => { c.req.query("q"); });
app.openapi(f, (c) => { c.req.query("q"); });
`;
    expect(routes(text)).toEqual([]);
  });

  test("ignores calls that are not route handlers", () => {
    const text = `
app.use("/x", (c, next) => { c.req.query("token"); return next(); });
app.openapi(r);
app.openapi(r, handlerRef);
app.openapi(r, ({ req }) => req.query("q"));
spec.openapi;
`;
    expect(routes(text)).toEqual([]);
  });

  test("reads string-literal property names", () => {
    const text = `
function helper() { return 1; }
const plain = () => 2;
const r = createRoute({ "request": { "query": Q }, [computed]: 1 });
app.openapi(r, (c) => { c.req.query("q"); c.req.valid(dynamic); });
`;
    expect(routes(text)).toEqual([]);
  });
});

describe("toolSchemaHits", () => {
  test("flags annotated, satisfies, array and factory tool literals without inputSchema", () => {
    const text = [
      "export const a: ConversationTool = { name: 'a', inputSchema: S };",
      "export const b: ConversationTool = { name: 'b' };",
      "export const c = { name: 'c' } satisfies ConversationTool;",
      "export const d: ConversationTool[] = [{ name: 'd' }, a, { name: 'd2', inputSchema }];",
      "function e(): ConversationTool { return { name: 'e' }; }",
      "const f = (): ConversationTool => ({ name: 'f' });",
      "const g: Readonly<ConversationTool> = { ...base };",
      "const h: readonly ConversationTool[] = [{ name: 'h' }];",
      "const i: ReadonlyArray<ConversationTool> = [{ name: 'i' }];",
      "const j: import('./tools').ConversationTool = { name: 'j' };",
      "const k: tools.ConversationTool = { name: 'k' };",
      "const l: Other = { name: 'l' };",
      "function m(): ConversationTool { const inner = () => ({ name: 'x' }); return { ...inner(), name: 'm' }; }",
      "const n: Array<Other> = [{ name: 'n' }];",
      "const o: ConversationTool = make();",
      "const p: Map<string, ConversationTool> = new Map();",
      "declare function q(): ConversationTool;",
    ].join("\n");
    expect(tools(text)).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11]);
  });
});
