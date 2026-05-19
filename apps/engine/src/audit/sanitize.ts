// Sanitizer for operator-supplied / parser-derived strings that land in
// `audit_log.metadata` or LLM context placeholders.
//
// Both surfaces feed external consumers we don't fully control: SIEMs
// (audit) and the model's prompt (LLM). Library error messages from
// pdf-parse / mammoth / xlsx can echo small slices of user-controlled
// bytes, and operator-supplied filenames can carry exotic characters.
// We bound the length and strip ASCII control + DEL so the downstream
// consumer sees a single deterministic line.
//
// This module sits in `audit/` next to `request-source.ts` so future
// routes that audit user-controlled error detail use one helper.

const DEFAULT_MAX_LEN = 200;

/** Strip ASCII control characters (NUL / TAB / CR / LF / DEL) and
 *  truncate to `maxLen`. Iterates char-by-char so biome's
 *  `noControlCharactersInRegex` rule stays happy. */
export function sanitizeForAudit(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}
