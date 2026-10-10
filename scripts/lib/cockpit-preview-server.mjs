import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function freePort() {
  return new Promise((ok, no) => {
    const probe = createServer();
    probe.once("error", no);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

export async function startPreviewServer() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const previewDir = await mkdtemp(resolve(tmpdir(), "subkit-cockpit-preview-"));
  try {
    await cp(resolve("assets/cockpit"), previewDir, { recursive: true });
  } catch (error) {
    await rm(previewDir, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(
    "bunx",
    [
      "vite",
      "preview",
      "--config",
      "apps/cockpit/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--outDir",
      previewDir,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const stop = async () => {
    try {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
        if (!child.killed) child.kill("SIGTERM");
      });
    } finally {
      await rm(previewDir, { recursive: true, force: true });
    }
  };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(
        `Cockpit preview unavailable — the preview server exited with code ${child.exitCode} before serving ${baseUrl}/cockpit/.`,
      );
    }
    const answered = await fetch(`${baseUrl}/cockpit/`)
      .then((res) => res.ok)
      .catch(() => false);
    if (answered) return { baseUrl, stop };
    await new Promise((ok) => setTimeout(ok, 250));
  }
  await stop();
  throw new Error(
    `Cockpit preview unavailable — the preview server never answered on ${baseUrl}/cockpit/ within 30 s.`,
  );
}
