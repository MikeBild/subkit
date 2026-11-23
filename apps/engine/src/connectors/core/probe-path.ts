const RETIRED_PROBE_PATHS: Readonly<Record<string, { from: string; to: string }>> = {
  jira: { from: "/rest/api/3/myself", to: "/myself" },
  salesforce: { from: "/services/data", to: "/sobjects" },
};

export const PROBE_PATH_TEMPLATE_SLUGS = Object.keys(RETIRED_PROBE_PATHS);

export type ProbePathRewrite =
  | { changed: false }
  | { changed: true; config: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function rewriteRetiredProbePath(
  templateSlug: string | null,
  config: unknown,
): ProbePathRewrite {
  const retired = templateSlug === null ? undefined : RETIRED_PROBE_PATHS[templateSlug];
  const current = record(config);
  const probe = record(current?.probe_endpoint);
  if (!retired || !current || !probe || probe.path !== retired.from) return { changed: false };
  return {
    changed: true,
    config: { ...current, probe_endpoint: { ...probe, path: retired.to } },
  };
}
