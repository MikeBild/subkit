// Reading an advisory report, whatever shape the tool answers in.
//
// This lives apart from `scripts/audit-advisories.ts` so it can be tested
// against a real answer. It had to be: the script carried the sentence "both
// shapes seen in the wild" as a comment, asserted `.advisories` and
// `.vulnerabilities`, and `bun audit --json` returns neither. It answers a flat
// map of package name to advisories. The reporter looked up two keys that were
// not there, found nothing, and printed "no high or critical advisories" over a
// tree that had one — a comment is a claim, only a test is evidence, and there
// was no fixture.
//
// The second defect is the one worth keeping in mind beyond this file: an
// unrecognised shape was indistinguishable from a clean tree. Both produced
// zero findings, and zero findings printed a positive verdict. A parser that
// does not understand its input must say so; it must never resolve its own
// confusion in favour of good news.

export interface Finding {
  package: string;
  severity: string;
  title: string;
  url?: string;
}

export interface AuditReading {
  findings: Finding[];
  /**
   * Whether any known shape was actually present.
   *
   * False with a non-empty answer means the tool said something this reader
   * cannot read — our defect, not the registry's, and not a clean tree.
   */
  recognised: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One advisory as `bun audit --json` writes it. */
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

  // npm's bulk endpoint, and older bun.
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

  // `bun audit --json`: the answer IS the map, one key per package.
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

  // An empty answer is the shape of a clean tree in every dialect, and there is
  // nothing in it to recognise. Saying "clean" there is honest.
  if (Object.keys(report).length === 0) recognised = true;

  return { findings, recognised };
}
