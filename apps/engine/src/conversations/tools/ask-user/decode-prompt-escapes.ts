// Readable ask_user_* prompts.
//
// A model sometimes double-encodes non-ASCII in its tool-call arguments: the
// question then holds the literal six characters `ß` instead of `ß`, and
// every surface (cockpit, MCP elicitation, chat) shows the escape to the user.
// The SDK wrapper decodes the human-facing text of an `ask_user_*` call once,
// where the model's arguments enter, so the tool-call row, the elicitation row
// and every frame built from them carry the readable text.
//
// Only prose is decoded. Machine identifiers (option values, field names, a
// choice or select default), patterns (`validation_regex`) and structured
// payloads (`commit_intent`, `target`, `diff`) keep their exact characters:
// a `\u` there can be meaningful, and a value has to round-trip unchanged.
// The user's answer never passes through here.

const ESCAPE_LENGTH = 6;

function readUnit(text: string, at: number): number | null {
  if (text[at] !== "\\" || text[at + 1] !== "u") return null;
  const hex = text.slice(at + 2, at + ESCAPE_LENGTH);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : null;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Decode literal JSON-style `\uXXXX` escapes, joining surrogate pairs. Left as
 * written: a lone surrogate, a malformed escape, an escape whose backslash is
 * itself escaped (`\\u00df`), and anything that would decode to a control
 * character. Text without escapes comes back unchanged.
 */
export function decodeLiteralUnicodeEscapes(text: string): string {
  if (!text.includes("\\u")) return text;
  let out = "";
  let from = 0;
  let at = text.indexOf("\\u");
  while (at >= 0) {
    const unit = readUnit(text, at);
    let consumed = 0;
    let decoded = "";
    if (unit !== null && text[at - 1] !== "\\") {
      if (isHigh(unit)) {
        const low = readUnit(text, at + ESCAPE_LENGTH);
        if (low !== null && isLow(low)) {
          decoded = String.fromCharCode(unit, low);
          consumed = ESCAPE_LENGTH * 2;
        }
      } else if (!isLow(unit) && unit >= 0x20 && unit !== 0x7f) {
        decoded = String.fromCharCode(unit);
        consumed = ESCAPE_LENGTH;
      }
    }
    if (consumed > 0) {
      out += text.slice(from, at) + decoded;
      from = at + consumed;
      at = text.indexOf("\\u", from);
    } else {
      at = text.indexOf("\\u", at + 2);
    }
  }
  return from === 0 ? text : out + text.slice(from);
}

type Args = Record<string, unknown>;

function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode the named string keys; same reference when nothing changed. */
function decodeKeys(obj: Args, keys: readonly string[]): Args {
  let out = obj;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value !== "string") continue;
    const decoded = decodeLiteralUnicodeEscapes(value);
    if (decoded === value) continue;
    if (out === obj) out = { ...obj };
    out[key] = decoded;
  }
  return out;
}

/** Decode `label`/`description` of object options; string options are values. */
function decodeOptions(options: unknown): unknown {
  if (!Array.isArray(options)) return options;
  let changed = false;
  const next = options.map((option) => {
    if (!isRecord(option)) return option;
    const decoded = decodeKeys(option, ["label", "description"]);
    if (decoded !== option) changed = true;
    return decoded;
  });
  return changed ? next : options;
}

function decodeField(field: unknown): unknown {
  if (!isRecord(field)) return field;
  const keys =
    field.type === "text"
      ? ["label", "placeholder", "error_message", "default"]
      : ["label", "placeholder", "error_message"];
  let out = decodeKeys(field, keys);
  const options = decodeOptions(field.options);
  if (options !== field.options) out = { ...out, options };
  return out;
}

/**
 * Decode the human-facing text of an `ask_user_*` call's arguments: the
 * question, summary and placeholder, option labels and descriptions, form
 * field labels/placeholders/error messages, and the pre-filled text of a free
 * text answer. Returns `args` itself for any other tool, or when nothing
 * needed decoding.
 */
export function decodeAskUserPromptEscapes(tool: string, args: Args): Args {
  if (!tool.startsWith("ask_user_")) return args;
  const keys =
    tool === "ask_user_text"
      ? ["question", "summary", "placeholder", "default"]
      : ["question", "summary", "placeholder"];
  let out = decodeKeys(args, keys);
  const options = decodeOptions(args.options);
  if (options !== args.options) out = { ...out, options };
  if (Array.isArray(args.fields)) {
    let changed = false;
    const fields = args.fields.map((field) => {
      const decoded = decodeField(field);
      if (decoded !== field) changed = true;
      return decoded;
    });
    if (changed) out = { ...out, fields };
  }
  return out;
}
