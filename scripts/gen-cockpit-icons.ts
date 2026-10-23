import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dir, "..");
const source = join(root, "apps/cockpit/public/favicon.svg");
for (const size of [192, 512]) {
  await sharp(source, { density: 300 })
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .png()
    .toFile(join(root, `apps/cockpit/public/app-icon-${size}.png`));
}

interface Source {
  icon: string;
  color?: string;
}

const SERVICES: Record<string, Source> = {
  airtable: { icon: "logos:airtable" },
  anthropic: { icon: "simple-icons:anthropic" },
  apple: { icon: "simple-icons:apple" },
  appstore: { icon: "simple-icons:appstore", color: "#0D96F6" },
  asana: { icon: "logos:asana-icon" },
  atlassian: { icon: "logos:atlassian" },
  aws: { icon: "simple-icons:amazonwebservices" },
  "aws-cloudwatch": { icon: "logos:aws-cloudwatch" },
  "aws-cognito": { icon: "logos:aws-cognito" },
  "aws-dynamodb": { icon: "logos:aws-dynamodb" },
  "aws-eventbridge": { icon: "logos:aws-eventbridge" },
  "aws-lambda": { icon: "logos:aws-lambda" },
  "aws-s3": { icon: "logos:aws-s3" },
  "aws-ses": { icon: "logos:aws-ses" },
  "aws-sqs": { icon: "logos:aws-sqs" },
  "aws-sts": { icon: "logos:aws-iam" },
  cloudflare: { icon: "logos:cloudflare-icon" },
  confluence: { icon: "logos:confluence" },
  digitalocean: { icon: "logos:digital-ocean-icon" },
  dropbox: { icon: "logos:dropbox" },
  firebase: { icon: "logos:firebase-icon" },
  github: { icon: "mdi:github" },
  "google-analytics": { icon: "logos:google-analytics" },
  "google-calendar": { icon: "logos:google-calendar" },
  "google-chat": { icon: "simple-icons:googlechat", color: "#00AC47" },
  "google-cloud-storage": { icon: "logos:google-cloud" },
  "google-docs": { icon: "simple-icons:googledocs", color: "#4285F4" },
  "google-drive": { icon: "logos:google-drive" },
  "google-gmail": { icon: "logos:google-gmail" },
  "google-search-console": { icon: "logos:google-search-console" },
  "google-sheets": { icon: "simple-icons:googlesheets", color: "#34A853" },
  "google-workspace": { icon: "logos:google-icon" },
  hubspot: { icon: "simple-icons:hubspot", color: "#FF7A59" },
  intercom: { icon: "logos:intercom-icon" },
  jira: { icon: "logos:jira" },
  linear: { icon: "logos:linear-icon" },
  linkedin: { icon: "mdi:linkedin", color: "#0A66C2" },
  mailchimp: { icon: "simple-icons:mailchimp" },
  metabase: { icon: "logos:metabase" },
  monday: { icon: "logos:monday-icon" },
  notion: { icon: "logos:notion-icon" },
  openai: { icon: "simple-icons:openai" },
  postgres: { icon: "logos:postgresql" },
  salesforce: { icon: "logos:salesforce" },
  sendgrid: { icon: "logos:sendgrid-icon" },
  shopify: { icon: "logos:shopify" },
  slack: { icon: "logos:slack-icon" },
  square: { icon: "simple-icons:square" },
  stripe: { icon: "simple-icons:stripe", color: "#635BFF" },
  supabase: { icon: "logos:supabase-icon" },
  twilio: { icon: "logos:twilio-icon" },
  vercel: { icon: "simple-icons:vercel" },
};

const TEMPLATE_SERVICE: Record<string, string> = {
  "app-store-connect": "appstore",
  "google-search-console": "google-search-console",
  "aws-apigw-iam": "aws",
  "appsync-cognito": "aws",
  "appsync-iam": "aws",
};

interface IconSet {
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string }>;
}

const sets = new Map<string, IconSet>();
function iconSet(prefix: string): IconSet {
  const known = sets.get(prefix);
  if (known) return known;
  const set = JSON.parse(
    readFileSync(join(root, `node_modules/@iconify-json/${prefix}/icons.json`), "utf8"),
  ) as IconSet;
  sets.set(prefix, set);
  return set;
}

function svg(name: string): { viewBox: string; body: string } {
  const [prefix, id] = name.split(":") as [string, string];
  const set = iconSet(prefix);
  const icon = set.icons[id] ?? set.icons[set.aliases?.[id]?.parent ?? ""];
  if (!icon) throw new Error(`Missing service icon ${name}`);
  const width = icon.width ?? set.width ?? 16;
  const height = icon.height ?? set.height ?? 16;
  const side = Math.max(width, height);
  const x = (width - side) / 2;
  const y = (height - side) / 2;
  return { viewBox: `${x} ${y} ${side} ${side}`, body: icon.body };
}

interface Template {
  slug: string;
  icon?: string;
  url_pattern?: string | null;
}

const templates = JSON.parse(
  readFileSync(join(root, "apps/engine/src/connectors/templates.json"), "utf8"),
) as Template[];

function templateService(template: Template): string | null {
  const named = TEMPLATE_SERVICE[template.slug];
  if (named) return named;
  const stem = (template.icon ?? "").replace(/\.svg$/, "");
  if (SERVICES[stem]) return stem;
  if (SERVICES[template.slug]) return template.slug;
  return null;
}

const icons = Object.keys(SERVICES)
  .sort()
  .map((key) => {
    const source = SERVICES[key] as Source;
    const { viewBox, body } = svg(source.icon);
    const colored = source.color ? body.replaceAll("currentColor", source.color) : body;
    const mono = colored.includes("currentColor");
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${colored.replaceAll("currentColor", "#000")}</svg>`;
    const src = `data:image/svg+xml,${encodeURIComponent(markup)}`;
    return `  ${JSON.stringify(key)}: { src: ${JSON.stringify(src)}, mono: ${mono} },`;
  });
const bySlug = templates
  .map((template) => [template.slug, templateService(template)] as const)
  .filter((entry): entry is readonly [string, string] => entry[1] !== null)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([slug, key]) => `  ${JSON.stringify(slug)}: ${JSON.stringify(key)},`);
const patterns = templates
  .filter((template) => template.url_pattern && templateService(template))
  .map(
    (template) =>
      `  [${JSON.stringify(template.url_pattern)}, ${JSON.stringify(templateService(template))}],`,
  );

const output = [
  "export interface ServiceIconData {",
  "  src: string;",
  "  mono: boolean;",
  "}",
  "",
  "export const SERVICE_ICONS: Record<string, ServiceIconData> = {",
  ...icons,
  "};",
  "",
  "export const TEMPLATE_SERVICES: Record<string, string> = {",
  ...bySlug,
  "};",
  "",
  "export const TEMPLATE_ADDRESSES: readonly (readonly [string, string])[] = [",
  ...patterns,
  "];",
  "",
].join("\n");

writeFileSync(join(root, "apps/cockpit/src/lib/service-icons.generated.ts"), output);
