import { csv } from "./csv.ts";
import { date } from "./date.ts";
import { money } from "./money.ts";
import { diff, template } from "./records.ts";
import { assert, schema } from "./schema.ts";
import { url } from "./url.ts";
import { xml } from "./xml.ts";
export const sandboxTools = Object.freeze({
  money,
  csv,
  date,
  schema,
  assert,
  url,
  xml,
  template,
  diff,
});
