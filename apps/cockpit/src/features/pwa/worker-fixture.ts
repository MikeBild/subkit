import { readFileSync } from "node:fs";

const read = (name: string) =>
  readFileSync(new URL(`../../../public/${name}`, import.meta.url), "utf8").trimEnd();

export function workerSource(name: "browser-worker.js" | "installation-worker.js"): string {
  return `${read("worker-notify.js")}\n${read(name)}\n`;
}
