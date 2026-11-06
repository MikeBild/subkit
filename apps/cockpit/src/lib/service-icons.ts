import { TEMPLATE_ADDRESSES, TEMPLATE_SERVICES } from "./service-icons.generated";

export interface ServiceIconData {
  src: string;
  mono: boolean;
}

let marks: Readonly<Record<string, ServiceIconData>> | null = null;
const waiting = new Set<() => void>();

const loading: Promise<void> = import("./service-icon-marks.generated")
  .then(
    (module) => module.SERVICE_ICONS,
    () => ({}),
  )
  .then((loaded) => {
    marks = loaded;
    for (const listener of waiting) listener();
  });

export function loadServiceMarks(): Promise<void> {
  return loading;
}

export function serviceMarksReady(): boolean {
  return marks !== null;
}

export function onServiceMarks(listener: () => void): () => void {
  waiting.add(listener);
  return () => waiting.delete(listener);
}

export type ServiceIdentity =
  | { kind: "brand"; key: string }
  | { kind: "subkit" }
  | { kind: "generic"; driver: string | null };

interface ServiceSource {
  template_slug?: string | null;
  base_url?: string | null;
  slug?: string | null;
  display_name?: string | null;
  driver?: string | null;
}

const NAME_SERVICES: Record<string, string> = {
  airtable: "airtable",
  anthropic: "anthropic",
  apple: "apple",
  appstore: "appstore",
  asana: "asana",
  atlassian: "atlassian",
  aws: "aws",
  claude: "anthropic",
  cloudflare: "cloudflare",
  confluence: "confluence",
  digitalocean: "digitalocean",
  dropbox: "dropbox",
  firebase: "firebase",
  github: "github",
  gmail: "google-gmail",
  hubspot: "hubspot",
  intercom: "intercom",
  jira: "jira",
  linear: "linear",
  linkedin: "linkedin",
  mailchimp: "mailchimp",
  metabase: "metabase",
  notion: "notion",
  openai: "openai",
  postgres: "postgres",
  postgresql: "postgres",
  rovo: "atlassian",
  salesforce: "salesforce",
  sendgrid: "sendgrid",
  shopify: "shopify",
  slack: "slack",
  stripe: "stripe",
  supabase: "supabase",
  twilio: "twilio",
  vercel: "vercel",
};

const AI_SERVICES = new Set(["anthropic", "openai"]);

const ADDRESSES = TEMPLATE_ADDRESSES.map(([pattern, key]) => [new RegExp(pattern), key] as const);

function hostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return new URL(address).host.toLowerCase();
  } catch {
    return null;
  }
}

function templateService(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const parts = slug.toLowerCase().split("-");
  for (let length = parts.length; length > 0; length--) {
    const key = TEMPLATE_SERVICES[parts.slice(0, length).join("-")];
    if (key) return key;
  }
  return null;
}

function words(source: ServiceSource): string[] {
  return [source.slug, source.display_name]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => {
      const tokens = value.toLowerCase().split(/[^a-z0-9]+/u);
      const joined = tokens.join("");
      return joined.includes("appstore") ? [...tokens, "appstore"] : tokens;
    });
}

export function serviceIdentity(source: ServiceSource, selfHost?: string | null): ServiceIdentity {
  const host = hostOf(source.base_url);
  if (host && selfHost && host === selfHost.toLowerCase()) return { kind: "subkit" };
  const template = source.template_slug ? TEMPLATE_SERVICES[source.template_slug] : undefined;
  if (template) return { kind: "brand", key: template };
  if (source.base_url) {
    const address = ADDRESSES.find(([pattern]) => pattern.test(source.base_url ?? ""));
    if (address) return { kind: "brand", key: address[1] };
  }
  const bySlug = templateService(source.slug);
  if (bySlug) return { kind: "brand", key: bySlug };
  const tokens = words(source);
  if (tokens.includes("subkit")) return { kind: "subkit" };
  const named = tokens.map((token) => NAME_SERVICES[token]).find(Boolean);
  if (named) return { kind: "brand", key: named };
  return { kind: "generic", driver: source.driver ?? null };
}

export function templateIdentity(
  templateSlug: string,
  baseUrl?: string | null,
  selfHost: string | null = currentHost(),
): ServiceIdentity {
  const host = hostOf(baseUrl);
  if (host && selfHost && host === selfHost.toLowerCase()) return { kind: "subkit" };
  const key = templateService(templateSlug);
  return key ? { kind: "brand", key } : { kind: "generic", driver: null };
}

export function serviceIcon(identity: ServiceIdentity): ServiceIconData | "loading" | null {
  if (identity.kind !== "brand") return null;
  if (marks === null) return "loading";
  return marks[identity.key] ?? null;
}

export function isAiService(identity: ServiceIdentity): boolean {
  return identity.kind === "brand" && AI_SERVICES.has(identity.key);
}

export function currentHost(): string | null {
  return typeof window === "undefined" ? null : window.location.host;
}
