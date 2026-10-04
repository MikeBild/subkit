import { scrubString } from "../../logging/scrub-secrets.ts";

const TOKEN_CHAR_RE = /[A-Za-z0-9+/=_.-]/;

export interface StreamScrubber {
  push(chunk: string): string;
  flush(): string;
}

export function createStreamScrubber(holdbackChars = 256): StreamScrubber {
  let pending = "";
  return {
    push(chunk: string): string {
      pending += chunk;
      if (pending.length <= holdbackChars) return "";
      let cut = pending.length - holdbackChars;
      while (
        cut > 0 &&
        TOKEN_CHAR_RE.test(pending.charAt(cut - 1)) &&
        TOKEN_CHAR_RE.test(pending.charAt(cut))
      ) {
        cut -= 1;
      }
      if (cut === 0) return "";
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
