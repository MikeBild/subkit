import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  assertDistributedWaveBinding,
  canonicalDistributedQualityTicket,
  distributedQualityTicketSha256,
  parseDistributedQualityTicket,
} from "./audit/distributed-quality-ticket.ts";
import { loadMutationWave } from "./run-mutation-shards.ts";

const repo = resolve(import.meta.dir, "../../..");
const required = (flag: string) => {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
};

export function validateDistributedQualityExecutor(options: {
  ticketPath: string;
  manifestPath: string;
  shardId: string;
  commit: string;
  githubRunId: string;
}): {
  ticket_sha256: string;
  wave_id: string;
  shard_id: string;
  coverage_run_id: string;
  campaign_timeout_ms: number;
} {
  const ticketText = readFileSync(options.ticketPath, "utf8");
  const ticket = parseDistributedQualityTicket(JSON.parse(ticketText));
  if (ticketText !== canonicalDistributedQualityTicket(ticket))
    throw new Error("Executor ticket serialization is noncanonical");
  if (relative(repo, resolve(options.ticketPath)) !== ticket.ticket_path)
    throw new Error("Executor ticket path differs from portable ticket");
  if (relative(repo, resolve(options.manifestPath)) !== ticket.manifest_path)
    throw new Error("Executor manifest path differs from portable ticket");
  if (
    ticket.coordinator_commit_sha !== options.commit ||
    ticket.github_run_id !== options.githubRunId
  )
    throw new Error("Executor workflow identity differs from portable ticket");
  if (
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() !==
    options.commit
  )
    throw new Error("Executor checkout differs from trusted commit");
  const prepared = loadMutationWave(repo, options.manifestPath);
  const shard = prepared.wave.shards.find((candidate) => candidate.id === options.shardId);
  if (!shard) throw new Error("Executor shard is absent from frozen wave");
  assertDistributedWaveBinding({
    ticket,
    manifestText: prepared.manifestText,
    wave: prepared.wave as unknown as Record<string, unknown>,
    shardId: options.shardId,
    targets: shard.targets,
  });
  return {
    ticket_sha256: distributedQualityTicketSha256(ticket),
    wave_id: ticket.wave_id,
    shard_id: shard.id,
    coverage_run_id: ticket.coverage_run_id,
    campaign_timeout_ms: ticket.campaign_timeout_ms,
  };
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      validateDistributedQualityExecutor({
        ticketPath: resolve(repo, required("--ticket")),
        manifestPath: resolve(repo, required("--manifest")),
        shardId: required("--shard"),
        commit: required("--commit"),
        githubRunId: required("--github-run-id"),
      }),
    ),
  );
