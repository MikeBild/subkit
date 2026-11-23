export interface RunRecordLink {
  label: string | null;
  url: string;
  connector: string;
  connectorName: string;
  stepKey: string;
}

export const RECORD_BUTTON_LIMIT = 2;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function runRecordLinks(detail: unknown): RunRecordLink[] {
  if (!record(detail) || !Array.isArray(detail.record_links)) return [];
  return detail.record_links.flatMap((entry) => {
    if (!record(entry)) return [];
    const url = httpsUrl(entry.url);
    if (!url || typeof entry.connector_name !== "string" || typeof entry.connector !== "string")
      return [];
    return [
      {
        label: typeof entry.label === "string" && entry.label ? entry.label : null,
        url,
        connector: entry.connector,
        connectorName: entry.connector_name,
        stepKey: typeof entry.step_key === "string" ? entry.step_key : "",
      },
    ];
  });
}

export function recordButtons(links: readonly RunRecordLink[]): RunRecordLink[] {
  return links.slice(0, RECORD_BUTTON_LIMIT);
}

export function recordSystems(links: readonly RunRecordLink[]): string {
  return [...new Set(links.map((link) => link.connectorName))].join(", ");
}

export function runStepTally(detail: unknown): { succeeded: number; total: number } | null {
  if (!record(detail) || !record(detail.outcome) || !record(detail.outcome.steps)) return null;
  const { succeeded, total } = detail.outcome.steps;
  return typeof succeeded === "number" && typeof total === "number" && total > 0
    ? { succeeded, total }
    : null;
}
