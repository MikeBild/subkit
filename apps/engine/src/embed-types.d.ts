declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}

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

declare module "*.bin" {
  const path: string;
  export default path;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.zip" {
  const path: string;
  export default path;
}

declare module "*.webp" {
  const path: string;
  export default path;
}

declare module "*.sh" {
  const content: string;
  export default content;
}

declare module "*/clipper/manifest.json" {
  const manifest: unknown;
  export default manifest;
}
