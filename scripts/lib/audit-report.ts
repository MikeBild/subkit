export interface Finding {
  package: string;
  severity: string;
  title: string;
  url?: string;
}

interface AuditReading {
  findings: Finding[];
  recognised: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeAdvisory(value: unknown): boolean {
  return isRecord(value) && ("severity" in value || "title" in value);
}

function fromEntry(name: string, entry: Record<string, unknown>): Finding {
  const url = entry.url;
  return {
    package: typeof entry.module_name === "string" ? entry.module_name : name,
    severity: String(entry.severity ?? "unknown"),
    title: String(entry.title ?? "untitled advisory"),
    ...(typeof url === "string" ? { url } : {}),
  };
}

export function readAuditReport(report: Record<string, unknown>): AuditReading {
  const findings: Finding[] = [];
  let recognised = false;

  const advisories = report.advisories;
  if (isRecord(advisories)) {
    recognised = true;
    for (const [name, entries] of Object.entries(advisories)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (isRecord(entry)) findings.push(fromEntry(name, entry));
      }
    }
  }

  const vulnerabilities = report.vulnerabilities;
  if (isRecord(vulnerabilities)) {
    recognised = true;
    for (const [name, raw] of Object.entries(vulnerabilities)) {
      if (!isRecord(raw)) continue;
      const via = Array.isArray(raw.via) ? raw.via : [];
      const titles = via.filter(isRecord).map((v) => String(v.title ?? "untitled advisory"));
      findings.push({
        package: typeof raw.name === "string" ? raw.name : name,
        severity: String(raw.severity ?? "unknown"),
        title: titles.length > 0 ? titles.join("; ") : "untitled advisory",
      });
    }
  }

  if (!recognised) {
    for (const [name, value] of Object.entries(report)) {
      const entries = Array.isArray(value) ? value : [value];
      if (!entries.some(looksLikeAdvisory)) continue;
      recognised = true;
      for (const entry of entries) {
        if (isRecord(entry)) findings.push(fromEntry(name, entry));
      }
    }
  }

  if (Object.keys(report).length === 0) recognised = true;

  return { findings, recognised };
}
