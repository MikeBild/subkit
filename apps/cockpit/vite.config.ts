import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const API_ORIGIN = process.env.SUBKIT_DEV_ORIGIN ?? "http://127.0.0.1:3000";
const root = fileURLToPath(new URL(".", import.meta.url));

function bareBase(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url === "/cockpit" || req.url?.startsWith("/cockpit?"))
      req.url = `/cockpit/${req.url.slice("/cockpit".length)}`;
    next();
  };
  return {
    name: "subkit-cockpit-bare-base",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  root,
  base: "/cockpit/",
  plugins: [react(), tailwind(), bareBase()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@ui": fileURLToPath(new URL("../../packages/ui/src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../../packages/shared/src", import.meta.url)),
      "@cli-core": fileURLToPath(new URL("../../packages/cli-core/src", import.meta.url)),
      "@engine/http/llms": fileURLToPath(new URL("../engine/src/http/llms", import.meta.url)),
    },
  },
  server: {
    port: 3010,
    proxy: Object.fromEntries(
      ["/v1", "/openapi.json", "/metrics", "/docs-images"].map((path) => [
        path,
        { target: API_ORIGIN, changeOrigin: true },
      ]),
    ),
  },
  build: {
    outDir: "../../assets/cockpit",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) {
            return "react";
          }
          if (id.includes("node_modules/@tanstack")) return "tanstack";
          return undefined;
        },
      },
    },
  },
});
