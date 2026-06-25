// Ambient declarations for `with { type: "text" }` import attributes.
//
// Bun resolves `.sql` / `.md` files imported with the text attribute to
// a string at compile time (via `bun build --compile`) and at module
// load (via `bun run` / `bun test`). TypeScript needs these
// declarations so the import sites in `db/migrations/embedded.ts` and
// `skills/embedded-seeds.ts` typecheck.

declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}

// `with { type: "file" }` imports (embedded-assets.ts) resolve to a STRING
// path Bun serves from the binary's virtual filesystem at runtime. The
// engine imports no .onnx/.wasm/.mjs as real modules, so a default-string
// declaration is unambiguous.
declare module "*.onnx" {
  const path: string;
  export default path;
}

declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.mjs" {
  const path: string;
  export default path;
}
