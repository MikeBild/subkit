import { isAbsolute, relative } from "node:path";

export interface LcovFunction {
  line: number;
  name: string;
  hits: number;
}

export interface LcovRecord {
  file: string;
  lines: Map<number, number>;
  functions: Map<string, LcovFunction>;
  functions_total: number | null;
  functions_covered: number | null;

  function_ids_complete: boolean;
}

function repositoryPath(repo: string, file: string): string {
  return isAbsolute(file) ? relative(repo, file) : file.replace(/^\.\//, "");
}

function nonNegativeInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export function parseLcov(text: string, repo: string): LcovRecord[] | { error: string } {
  const records: LcovRecord[] = [];
  let record: LcovRecord | null = null;
  const finishRecord = (): { error: string } | undefined => {
    if (!record) return undefined;
    const hasTotal = record.functions_total !== null;
    const hasCovered = record.functions_covered !== null;
    if (hasTotal !== hasCovered)
      return { error: "invalid LCOV function summary: FNF and FNH must appear together" };
    const known = [...record.functions.values()].filter((fn) => fn.line > 0);
    const knownCovered = known.filter((fn) => fn.hits > 0).length;
    record.function_ids_complete = hasTotal
      ? known.length === record.functions_total && knownCovered === record.functions_covered
      : known.length > 0 && known.length === record.functions.size;
    records.push(record);
    record = null;
    return undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const finished = finishRecord();
      if (finished) return finished;
      record = {
        file: repositoryPath(repo, line.slice(3)),
        lines: new Map(),
        functions: new Map(),
        functions_total: null,
        functions_covered: null,
        function_ids_complete: false,
      };
      continue;
    }
    if (line === "end_of_record") {
      const finished = finishRecord();
      if (finished) return finished;
      continue;
    }
    if (!record) continue;
    if (line.startsWith("DA:")) {
      const [number, hits] = line.slice(3).split(",");
      const sourceLine = nonNegativeInt(number);
      const count = nonNegativeInt(hits);
      if (sourceLine === null || count === null)
        return { error: `invalid LCOV DA record: ${line}` };
      record.lines.set(sourceLine, Math.max(record.lines.get(sourceLine) ?? 0, count));
      continue;
    }
    if (line.startsWith("FN:")) {
      const [number, ...nameParts] = line.slice(3).split(",");
      const sourceLine = nonNegativeInt(number);
      const name = nameParts.join(",");
      if (sourceLine === null || name.length === 0)
        return { error: `invalid LCOV FN record: ${line}` };
      const key = `${sourceLine}:${name}`;
      record.functions.set(key, {
        line: sourceLine,
        name,
        hits: record.functions.get(key)?.hits ?? 0,
      });
      continue;
    }
    if (line.startsWith("FNDA:")) {
      const [hits, ...nameParts] = line.slice(5).split(",");
      const count = nonNegativeInt(hits);
      const name = nameParts.join(",");
      if (count === null || name.length === 0)
        return { error: `invalid LCOV FNDA record: ${line}` };
      const existing = [...record.functions.values()].find((fn) => fn.name === name);
      if (existing) existing.hits = Math.max(existing.hits, count);
      else record.functions.set(`?:${name}`, { line: 0, name, hits: count });
      continue;
    }
    if (line.startsWith("FNF:")) {
      const count = nonNegativeInt(line.slice(4));
      if (count === null) return { error: `invalid LCOV FNF record: ${line}` };
      if (record.functions_covered !== null && record.functions_covered > count) {
        return {
          error: `invalid LCOV function summary: FNH exceeds FNF (${record.functions_covered}>${count})`,
        };
      }
      record.functions_total = count;
      continue;
    }
    if (line.startsWith("FNH:")) {
      const count = nonNegativeInt(line.slice(4));
      if (count === null) return { error: `invalid LCOV FNH record: ${line}` };
      if (record.functions_total !== null && count > record.functions_total) {
        return {
          error: `invalid LCOV function summary: FNH exceeds FNF (${count}>${record.functions_total})`,
        };
      }
      record.functions_covered = count;
    }
  }
  const finished = finishRecord();
  if (finished) return finished;
  return records;
}

export function mergeLcov(records: readonly LcovRecord[]): LcovRecord[] {
  const merged = new Map<string, LcovRecord>();
  for (const record of records) {
    const target = merged.get(record.file) ?? {
      file: record.file,
      lines: new Map<number, number>(),
      functions: new Map<string, LcovFunction>(),
      functions_total: null,
      functions_covered: null,
      function_ids_complete: true,
    };
    merged.set(record.file, target);
    for (const [line, hits] of record.lines)
      target.lines.set(line, Math.max(target.lines.get(line) ?? 0, hits));
    for (const [key, fn] of record.functions) {
      const prior = target.functions.get(key);
      target.functions.set(key, { ...fn, hits: Math.max(prior?.hits ?? 0, fn.hits) });
    }
    if (record.functions_total !== null) {
      target.functions_total = Math.max(target.functions_total ?? 0, record.functions_total);
    }
    if (record.functions_covered !== null) {
      target.functions_covered = Math.max(target.functions_covered ?? 0, record.functions_covered);
    }
    target.function_ids_complete &&= record.function_ids_complete;
  }
  return [...merged.values()].sort((left, right) => left.file.localeCompare(right.file));
}

export function coverageRows(records: readonly LcovRecord[]): Array<{
  file: string;
  funcs: number;
  lines: number;
  functions_covered: number | null;
  functions_total: number | null;
  lines_covered: number;
  lines_total: number;
}> {
  return records.map((record) => {
    const lines = [...record.lines.values()];
    const functions = [...record.functions.values()];
    const knownFunctions = functions.filter((fn) => fn.line > 0);
    const percent = (values: readonly { hits: number }[]) =>
      values.length === 0
        ? 100
        : (values.filter((entry) => entry.hits > 0).length / values.length) * 100;
    const knownCovered = knownFunctions.filter((entry) => entry.hits > 0).length;
    const functionsMeasured = record.function_ids_complete || record.functions_total !== null;
    const functionsTotal = record.function_ids_complete
      ? knownFunctions.length
      : record.functions_total === null
        ? null
        : Math.max(record.functions_total, knownFunctions.length);
    const functionsCovered = record.function_ids_complete
      ? knownCovered
      : record.functions_covered === null
        ? null
        : Math.max(record.functions_covered, knownCovered);
    const linesCovered = lines.filter((hits) => hits > 0).length;
    return {
      file: record.file,
      funcs:
        functionsMeasured && functionsTotal !== null && functionsCovered !== null
          ? functionsTotal === 0
            ? 100
            : (functionsCovered / functionsTotal) * 100
          : 0,
      lines: percent(lines.map((hits) => ({ hits }))),
      functions_covered: functionsCovered,
      functions_total: functionsTotal,
      lines_covered: linesCovered,
      lines_total: lines.length,
    };
  });
}

export function renderLcov(records: readonly LcovRecord[]): string {
  const out: string[] = [];
  for (const record of records) {
    out.push(`SF:${record.file}`);
    const functions = [...record.functions.values()].sort(
      (left, right) => left.line - right.line || left.name.localeCompare(right.name),
    );
    for (const fn of functions) if (fn.line > 0) out.push(`FN:${fn.line},${fn.name}`);
    for (const fn of functions) out.push(`FNDA:${fn.hits},${fn.name}`);
    out.push(
      `FNF:${record.functions_total ?? functions.length}`,
      `FNH:${record.functions_covered ?? functions.filter((fn) => fn.hits > 0).length}`,
    );
    for (const [line, hits] of [...record.lines].sort(([left], [right]) => left - right))
      out.push(`DA:${line},${hits}`);
    out.push(
      `LF:${record.lines.size}`,
      `LH:${[...record.lines.values()].filter((hits) => hits > 0).length}`,
      "end_of_record",
    );
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
