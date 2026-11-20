import type { BrowserWindow } from "electron";
import {
  CAPTURE_MASK_CSS,
  CAPTURE_MAX_BYTES,
  CAPTURE_SETTLE_SCRIPT,
  CAPTURE_SETTLE_TIMEOUT_MS,
  fitCapture,
} from "../shared/capture.ts";

function settled(window: BrowserWindow): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CAPTURE_SETTLE_TIMEOUT_MS);
  });
  const painted = window.webContents
    .executeJavaScript(CAPTURE_SETTLE_SCRIPT, true)
    .then((value) => value === true)
    .catch(() => false);
  return Promise.race([painted, timeout]).finally(() => clearTimeout(timer));
}

export async function captureWindow(window: BrowserWindow): Promise<string | null> {
  if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) return null;
  const contents = window.webContents;
  let mask: string | null = null;
  try {
    mask = await contents.insertCSS(CAPTURE_MASK_CSS, { cssOrigin: "user" });
    if (!(await settled(window))) return null;
    const image = await contents.capturePage();
    const size = fitCapture(image.getSize());
    if (!size) return null;
    const png = image.resize({ ...size, quality: "good" }).toPNG();
    return png.byteLength > 0 && png.byteLength <= CAPTURE_MAX_BYTES
      ? png.toString("base64")
      : null;
  } catch {
    return null;
  } finally {
    if (mask !== null && !window.isDestroyed())
      await contents.removeInsertedCSS(mask).catch(() => {});
  }
}
