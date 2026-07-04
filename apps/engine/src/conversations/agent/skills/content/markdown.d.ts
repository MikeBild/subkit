// Bun's `with { type: "text" }` import attribute lets us inline .md
// bodies into the bundle. TypeScript needs a module declaration to
// type the import. Each .md file in this directory exports its body
// as a string default.
declare module "*.md" {
  const content: string;
  export default content;
}
