export { default as SANDBOX_TOOL_MANIFEST } from "./helpers.manifest.json";

import assertSource from "./helpers/assert.js" with { type: "text" };
import coreSource from "./helpers/core.js" with { type: "text" };
import csvSource from "./helpers/csv.js" with { type: "text" };
import dateSource from "./helpers/date.js" with { type: "text" };
import diffSource from "./helpers/diff.js" with { type: "text" };
import moneySource from "./helpers/money.js" with { type: "text" };
import schemaSource from "./helpers/schema.js" with { type: "text" };
import templateSource from "./helpers/template.js" with { type: "text" };
import urlSource from "./helpers/url.js" with { type: "text" };
import xmlSource from "./helpers/xml.js" with { type: "text" };
export const STDLIB_CORE_SOURCE = coreSource as unknown as string;
export const STDLIB_HELPER_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  money: moneySource as unknown as string,
  csv: csvSource as unknown as string,
  date: dateSource as unknown as string,
  schema: schemaSource as unknown as string,
  assert: assertSource as unknown as string,
  url: urlSource as unknown as string,
  xml: xmlSource as unknown as string,
  template: templateSource as unknown as string,
  diff: diffSource as unknown as string,
});
const lazyTools = `(function(){
  const load = globalThis.__sk_helper_source__;
  delete globalThis.__sk_helper_source__;
  const values = {};
  const tools = {};
  for (const name of ["money","csv","date","schema","assert","url","xml","template","diff"]) {
    Object.defineProperty(tools,name,{enumerable:true,get:function(){
      if (!Object.prototype.hasOwnProperty.call(values,name)) {
        (0,eval)(load(name));
        values[name] = globalThis.__sk_tool_value__;
        delete globalThis.__sk_tool_value__;
      }
      return values[name];
    }});
  }
  Object.defineProperty(globalThis,"__sk_tools__",{value:tools,configurable:true});
})();`;
export const STDLIB_SOURCE = `${lazyTools}\n${STDLIB_CORE_SOURCE}`;
const versionMatch = STDLIB_CORE_SOURCE.match(/version:\s*"([^"]+)"/);
if (!versionMatch) throw new Error("sk-stdlib: could not extract version from stdlib.js");
export const STDLIB_VERSION: string = versionMatch[1] ?? "0.0.0";
