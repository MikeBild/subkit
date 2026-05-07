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
