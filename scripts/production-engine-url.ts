#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

export type DeploymentStatus = {
  state: string;
  environment_url?: string | null;
  created_at: string;
};

export type Deployment = {
  id: number;
  created_at: string;
  statuses: DeploymentStatus[];
};

export type Resolution = { url: string } | { url: null; reason: string };

export type ResolveOptions = {
  token: string | undefined;
  repository: string;
  since: Date;
  timeoutMs: number;
  pollMs: number;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const CLOCK_MARGIN_MS = 120_000;

function engineUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function reportedEngineUrl(deployments: Deployment[], since: Date): string | null {
  const earliest = since.getTime() - CLOCK_MARGIN_MS;
  let newest: { url: string; at: number } | null = null;
  for (const deployment of deployments) {
    if (Date.parse(deployment.created_at) < earliest) continue;
    for (const status of deployment.statuses) {
      if (status.state !== "success") continue;
      const url = engineUrl(status.environment_url);
      if (!url) continue;
      const at = Date.parse(status.created_at);
      if (!newest || at > newest.at) newest = { url, at };
    }
  }
  return newest?.url ?? null;
}

const FINISHED = new Set(["success", "failure", "error", "inactive"]);

export function finishedWithoutUrl(deployments: Deployment[], since: Date): boolean {
  const earliest = since.getTime() - CLOCK_MARGIN_MS;
  const recent = deployments.filter((deployment) => Date.parse(deployment.created_at) >= earliest);
  return (
    recent.length > 0 &&
    recent.every((deployment) =>
      deployment.statuses.some((status) => FINISHED.has(status.state)),
    ) &&
    reportedEngineUrl(recent, since) === null
  );
}

class Unreadable extends Error {}

async function readDeployments(options: ResolveOptions): Promise<Deployment[] | null> {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const api = `https://api.github.com/repos/${options.repository}`;
  const read = async (url: string): Promise<unknown> => {
    const res = await options.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403 || res.status === 404)
      throw new Unreadable(`HTTP ${res.status}`);
    if (!res.ok) return null;
    return res.json();
  };
  const listed = await read(`${api}/deployments?environment=production&per_page=20`);
  if (!Array.isArray(listed)) return null;
  const earliest = options.since.getTime() - CLOCK_MARGIN_MS;
  const deployments: Deployment[] = [];
  for (const entry of listed as Array<{ id: number; created_at: string }>) {
    if (Date.parse(entry.created_at) < earliest) continue;
    const statuses = await read(`${api}/deployments/${entry.id}/statuses?per_page=20`);
    if (!Array.isArray(statuses)) return null;
    deployments.push({
      id: entry.id,
      created_at: entry.created_at,
      statuses: statuses as DeploymentStatus[],
    });
  }
  return deployments;
}

async function servesSubkit(options: ResolveOptions, url: string): Promise<boolean | null> {
  try {
    const res = await options.fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { service?: unknown };
    return body.service === "subkit";
  } catch {
    return null;
  }
}

export async function resolveProductionEngineUrl(options: ResolveOptions): Promise<Resolution> {
  if (!options.token)
    return { url: null, reason: "the deployment dispatch token is not configured" };
  const deadline = options.now() + options.timeoutMs;
  const minutes = Math.round(options.timeoutMs / 60_000);
  let candidate: string | null = null;
  while (true) {
    let deployments: Deployment[] | null = null;
    try {
      deployments = await readDeployments(options);
    } catch (error) {
      if (error instanceof Unreadable)
        return {
          url: null,
          reason: `the deployments of ${options.repository} are not readable with the deployment dispatch token (${error.message})`,
        };
      deployments = null;
    }
    candidate = deployments ? reportedEngineUrl(deployments, options.since) : candidate;
    if (!candidate && deployments && finishedWithoutUrl(deployments, options.since))
      return {
        url: null,
        reason: `the production deployment of ${options.repository} finished without reporting an engine URL`,
      };
    if (candidate) {
      const identity = await servesSubkit(options, candidate);
      if (identity === true) return { url: candidate };
      if (identity === false)
        return {
          url: null,
          reason: "the reported production URL does not answer as a SubKit engine",
        };
    }
    if (options.now() >= deadline)
      return {
        url: null,
        reason: candidate
          ? `the reported production URL did not answer as a SubKit engine within ${minutes} minutes`
          : `no production deployment of ${options.repository} reported an engine URL within ${minutes} minutes`,
      };
    await options.sleep(options.pollMs);
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(`production-engine-url: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

if (import.meta.main) {
  const repository = argument("--repository");
  const since = new Date(argument("--since"));
  if (Number.isNaN(since.getTime())) {
    console.error("production-engine-url: --since is not a timestamp");
    process.exit(2);
  }
  const result = await resolveProductionEngineUrl({
    token: process.env.GH_TOKEN || undefined,
    repository,
    since,
    timeoutMs: 20 * 60_000,
    pollMs: 20_000,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
  const output = process.env.GITHUB_OUTPUT;
  if (result.url !== null) {
    console.log(`production engine: ${result.url}`);
    if (output) appendFileSync(output, `url=${result.url}\n`);
  } else {
    console.log(`::notice::production verification skipped: ${result.reason}`);
    if (output) appendFileSync(output, `url=\nreason=${result.reason}\n`);
  }
}
