const ESCAPE_LENGTH = 6;

function readUnit(text: string, at: number): number | null {
  if (text[at] !== "\\" || text[at + 1] !== "u") return null;
  const hex = text.slice(at + 2, at + ESCAPE_LENGTH);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : null;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

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
