// Streaming secret scrubber for the raw `text_delta` path.
//
// The batch guard (`runOutputGuard` in `onStepFinish`) redacts the
// persisted assistant message, but the live `text_delta` events are
// pushed straight off the provider stream — a secret can reach the
// client before the batch pass ever runs. This scrubber sits between
// the stream drain and the event sink:
//
//   - HOLDBACK: the last `holdbackChars` (default 256) of the stream
//     are always retained unscanned. A secret split across chunk
//     boundaries (each half alone unmatchable) is only recognisable
//     once both halves sit in the same buffer; 256 chars comfortably
//     covers ~190-char Atlassian API tokens straddling a chunk seam.
//   - The retained tail is held RAW (not scrubbed) — scrubbing a
//     partial token would either miss it or corrupt offsets; the tail
//     is scrubbed when it is eventually emitted (next `push`) or on
//     `flush()`.
//   - BOUNDARY NUDGE: the emit/hold cut-point is moved left off any
//     contiguous run of token-charset characters `[A-Za-z0-9+/=_.-]`,
//     so a secret-shaped run is never split across emit/hold (the
//     emitted prefix would scan clean and the secret would leak in
//     halves). If the entire emittable prefix is one unbroken token
//     run, nothing is emitted this push — `flush()` drains it.
//
// `flush()` MUST be called when the stream ends (the loop does so in
// the drain's `finally`), otherwise the held tail is lost.

import { scrubString } from "../../logging/scrub-secrets.ts";

/** Charset of every secret pattern (incl. JWT/bearer dots). A cut
 *  inside a run of these could split a token across emit/hold. */
const TOKEN_CHAR_RE = /[A-Za-z0-9+/=_.-]/;

export interface StreamScrubber {
  /** Feed a raw chunk; returns the scrubbed text safe to emit now ("" when holding). */
  push(chunk: string): string;
  /** Drain and scrub the held tail. Call exactly once at stream end. */
  flush(): string;
}

export function createStreamScrubber(holdbackChars = 256): StreamScrubber {
  let pending = "";
  return {
    push(chunk: string): string {
      pending += chunk;
      if (pending.length <= holdbackChars) return "";
      let cut = pending.length - holdbackChars;
      // Nudge the cut left while it would split a contiguous
      // token-charset run (char on BOTH sides of the cut is in the
      // charset). Stops at the start of the run — the whole run then
      // stays in the held tail and is scanned in one piece.
      while (
        cut > 0 &&
        TOKEN_CHAR_RE.test(pending.charAt(cut - 1)) &&
        TOKEN_CHAR_RE.test(pending.charAt(cut))
      ) {
        cut -= 1;
      }
      if (cut === 0) return ""; // no boundary yet — keep holding, flush drains it
      const out = scrubString(pending.slice(0, cut));
      pending = pending.slice(cut);
      return out;
    },
    flush(): string {
      const out = scrubString(pending);
      pending = "";
      return out;
    },
  };
}
