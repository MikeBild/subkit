import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { DOCS_IMAGES, type EmbeddedDocsImage } from "../docs-images-embedded.ts";
import type { AppEnv } from "../openapi.ts";

const FILE_NAME = /^[a-z0-9-]+\.(en|de)\.webp$/;

const IMMUTABLE = "public, max-age=31536000, immutable";

const SHORT = "public, max-age=300";

const route = createRoute({
  method: "get",
  path: "/docs-images/{file}",
  tags: ["docs"],
  summary: "A screenshot the documentation references",
  description:
    "Serves one WebP screenshot embedded in this engine binary, as referenced from /docs.json and /llms-full.txt. A request whose v query matches the first twelve hex digits of the image sha256 may be cached forever; any other request gets a short cache lifetime.",
  request: {
    params: z.object({
      file: z.string().openapi({ example: "first-workflow-run-result.en.webp" }),
    }),
    query: z.object({ v: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Screenshot",
      content: { "image/webp": { schema: z.string().openapi({ format: "binary" }) } },
    },
    304: {
      description: "The cached screenshot with this ETag is still current",
    },
    404: {
      description: "No such screenshot",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((entry) => {
    const tag = entry.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

export function registerDocsImageRoutes(
  app: OpenAPIHono<AppEnv>,
  images: Readonly<Record<string, EmbeddedDocsImage>> = DOCS_IMAGES,
): void {
  app.openAPIRegistry.registerPath(route);
  app.get("/docs-images/:file", async (c) => {
    const file = c.req.param("file");
    const image = FILE_NAME.test(file) && Object.hasOwn(images, file) ? images[file] : undefined;
    if (!image) {
      return c.text(`Not found: /docs-images/${file}\n`, 404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
    }
    const etag = `"${image.sha256}"`;
    const cacheControl = c.req.query("v") === image.sha256.slice(0, 12) ? IMMUTABLE : SHORT;
    const shared = {
      etag,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": cacheControl,
    };
    if (matchesEtag(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, shared);
    }
    const bytes = new Uint8Array(await Bun.file(image.path).arrayBuffer());
    return c.body(bytes, 200, {
      ...shared,
      "content-type": "image/webp",
      "content-length": String(bytes.byteLength),
    });
  });
}
