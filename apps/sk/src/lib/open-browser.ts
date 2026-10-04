import { spawn } from "node:child_process";
import { z } from "zod";

export const BrowserUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "URL must be an http(s) URL",
  });

export function assertHttpsUrl(url: string): string {
  const parsed = BrowserUrlSchema.safeParse(url);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "invalid URL");
  }
  return parsed.data;
}

export function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let validated: string;
    try {
      validated = assertHttpsUrl(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("invalid URL"));
      return;
    }
    const platform = process.platform;
    const [bin, args] =
      platform === "darwin"
        ? (["open", [validated]] as const)
        : platform === "win32"
          ? (["cmd.exe", ["/c", "start", "", validated]] as const)
          : (["xdg-open", [validated]] as const);
    const child = spawn(bin, [...args], {
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.unref();
    resolve();
  });
}
