import { z } from "@hono/zod-openapi";

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/g;
const WEB_HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const RECORD_PATH = /^\/[A-Za-z0-9_.{}/-]*$/;

export const RecordWebHostSchema = z
  .string()
  .regex(WEB_HOST, "web host must be a lowercase host name, optionally starting with *.")
  .openapi({
    description:
      "A web host that record links may point to. A leading `*.` allows exactly one extra label.",
  });

const RecordUrlConditionSchema = z
  .object({
    field: z.string().regex(FIELD_PATH),
    equals: z.union([z.string(), z.number(), z.boolean()]),
  })
  .openapi("ConnectorTemplateRecordUrlCondition");

export const RecordUrlPatternSchema = z
  .object({
    methods: z.array(z.enum(["POST", "PUT", "PATCH"])).min(1),
    path: z
      .string()
      .regex(RECORD_PATH, "path must start with / and use {name} placeholders")
      .optional()
      .openapi({
        description:
          "Request path after the connector base path, with {name} placeholders. Omitted for GraphQL templates.",
      }),
    url_field: z.string().regex(FIELD_PATH).optional().openapi({
      description: "Dotted path to a web URL in the response.",
    }),
    url_template: z.string().min(1).max(512).optional().openapi({
      description:
        "Web URL built from path placeholders, host placeholders of the base URL, or dotted response fields.",
    }),
    label: z.string().min(1).max(120).optional().openapi({
      description: "Language-neutral record label with the same placeholders, for example {key}.",
    }),
    when: RecordUrlConditionSchema.optional(),
  })
  .refine((entry) => entry.url_field !== undefined || entry.url_template !== undefined, {
    message: "record url pattern needs url_field or url_template",
  })
  .openapi("ConnectorTemplateRecordUrlPattern");

export type RecordUrlPattern = z.infer<typeof RecordUrlPatternSchema>;

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

export function webHostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((allowed) => {
    if (!allowed.startsWith("*.")) return host === allowed;
    const suffix = allowed.slice(1);
    if (!host.endsWith(suffix)) return false;
    const label = host.slice(0, -suffix.length);
    return label.length > 0 && !label.includes(".");
  });
}

export function safeWebUrl(raw: unknown, hosts: readonly string[]): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return webHostAllowed(url.hostname, hosts) ? url.toString() : null;
}

export function hostPlaceholders(baseUrl: string | null): Set<string> {
  if (!baseUrl) return new Set();
  const host = baseUrl.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  return new Set(placeholdersOf(host));
}

interface RecordUrlTemplateFacts {
  slug: string;
  driver: string;
  base_url: string | null;
  web_hosts: readonly string[];
  record_url_patterns: readonly RecordUrlPattern[];
}

export function recordUrlPatternIssues(t: RecordUrlTemplateFacts): Array<{
  path: (string | number)[];
  message: string;
}> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  if (t.record_url_patterns.length > 0 && t.web_hosts.length === 0)
    issues.push({
      path: ["web_hosts"],
      message: `template "${t.slug}" declares record_url_patterns but no web_hosts`,
    });
  const graphql = t.driver === "graphql";
  const hostNames = hostPlaceholders(t.base_url);
  t.record_url_patterns.forEach((entry, index) => {
    const at = ["record_url_patterns", index];
    if (graphql && entry.path !== undefined)
      issues.push({
        path: [...at, "path"],
        message: `template "${t.slug}" is GraphQL; record url patterns match the response, not a path`,
      });
    if (!graphql && entry.path === undefined)
      issues.push({ path: [...at, "path"], message: `template "${t.slug}" needs a request path` });
    const pathNames = entry.path ? placeholdersOf(entry.path) : [];
    if (
      pathNames.some((name) => name.includes(".")) ||
      new Set(pathNames).size !== pathNames.length
    )
      issues.push({
        path: [...at, "path"],
        message: `template "${t.slug}" path placeholders must be unique simple names`,
      });
    if (entry.url_template !== undefined) {
      const probe = entry.url_template.replace(PLACEHOLDER, "x");
      const literalHost = entry.url_template.replace(/^https:\/\//, "").split("/")[0] ?? "";
      if (
        !entry.url_template.startsWith("https://") ||
        literalHost.includes("{") ||
        safeWebUrl(probe, t.web_hosts) === null
      )
        issues.push({
          path: [...at, "url_template"],
          message: `template "${t.slug}" url_template must be https on a literal host listed in web_hosts`,
        });
    }
    const shadowed = pathNames.filter((name) => hostNames.has(name));
    if (shadowed.length > 0)
      issues.push({
        path: [...at, "path"],
        message: `template "${t.slug}" path placeholders ${shadowed.join(", ")} clash with base URL host placeholders`,
      });
  });
  return issues;
}
