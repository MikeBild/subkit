export const CAPTURE_MAX_WIDTH = 1600;
export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
export const CAPTURE_SETTLE_TIMEOUT_MS = 1500;
export const CAPTURE_REUSE_MS = 60_000;

const SECRET_WORDS = ["password", "passwd", "secret", "token", "api_key", "api-key", "apikey"];
const SECRET_ATTRIBUTES = ["name", "id", "autocomplete"];

export const CAPTURE_MASKED_SELECTORS: readonly string[] = [
  'input[type="password"]',
  'input[autocomplete~="one-time-code"]',
  ...["input", "textarea"].flatMap((element) =>
    SECRET_ATTRIBUTES.flatMap((attribute) =>
      SECRET_WORDS.map((word) => `${element}[${attribute}*="${word}" i]`),
    ),
  ),
  "[data-sensitive]",
  "[data-secret]",
];

export const CAPTURE_MASK_CSS = `${CAPTURE_MASKED_SELECTORS.join(",")}{visibility:hidden !important;}`;

export const CAPTURE_SETTLE_SCRIPT =
  "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";

export interface CaptureSize {
  width: number;
  height: number;
}

export function fitCapture(size: CaptureSize, maxWidth = CAPTURE_MAX_WIDTH): CaptureSize | null {
  if (!(size.width > 0) || !(size.height > 0)) return null;
  if (size.width <= maxWidth)
    return { width: Math.round(size.width), height: Math.round(size.height) };
  return {
    width: maxWidth,
    height: Math.max(1, Math.round((size.height * maxWidth) / size.width)),
  };
}

export interface PendingCapture {
  png: string;
  at: number;
}

export function reusableCapture(
  pending: PendingCapture | null,
  now: number,
  maxAge = CAPTURE_REUSE_MS,
): string | null {
  if (!pending) return null;
  const age = now - pending.at;
  return age >= 0 && age <= maxAge ? pending.png : null;
}
