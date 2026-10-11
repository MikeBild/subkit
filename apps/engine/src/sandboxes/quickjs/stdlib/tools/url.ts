import URL from "core-js-pure/actual/url/index.js";
import { text } from "./limits.ts";

type Query = [string, string][];
function parseUrl(source: string, base?: string): InstanceType<typeof URL> {
  const value = new URL(text(source), base === undefined ? undefined : text(base));
  if (value.username || value.password) throw new Error("URL credentials are unsupported");
  return value;
}
export const url = Object.freeze({
  parse(source: string, base?: string) {
    const value = parseUrl(source, base);
    return {
      href: value.href,
      protocol: value.protocol,
      username: value.username,
      password: value.password,
      hostname: value.hostname,
      port: value.port,
      pathname: value.pathname,
      hash: value.hash,
      query: [...value.searchParams.entries()] as Query,
    };
  },
  build(source: string, options: { query?: Query; hash?: string; pathname?: string } = {}) {
    const value = parseUrl(source);
    if (options.query) {
      value.search = "";
      for (const [key, item] of options.query) value.searchParams.append(text(key), text(item));
    }
    if (options.hash !== undefined) value.hash = text(options.hash);
    if (options.pathname !== undefined) value.pathname = text(options.pathname);
    return text(value.href);
  },
  query(source: string): Query {
    return [...parseUrl(source).searchParams.entries()];
  },
  encode: (source: string) => encodeURIComponent(text(source)),
  decode: (source: string) => decodeURIComponent(text(source)),
});
