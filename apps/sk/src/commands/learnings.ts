// `sk learnings` — the human curation gate of the coding-agent capture
// loop. Session learnings arrive as `session_learning` skill candidates
// (status: proposed); this command reviews them one by one: approve
// (optionally after editing) promotes to an ACTIVE skill that the next
// session briefing carries, reject retires the fingerprint for good.

import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

interface LearningCandidate {
  id: string;
  title: string;
  body: string;
  pitfalls?: string[];
  tags?: string[];
  confidence: string;
  evidence_count: number;
  created_at: string;
}

async function fetchProposed(client: EngineClient): Promise<LearningCandidate[]> {
  const { items } = await client.listSkillCandidates({
    status: "proposed",
    pattern_kind: "session_learning",
    limit: 100,
  });
  return items as unknown as LearningCandidate[];
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List proposed session learnings" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const items = await fetchProposed(client);
      if (args.json) {
        printJson(items);
        return;
      }
      const rows = items.map((c) => ({
        id: c.id,
        title: c.title,
        tags: (c.tags ?? []).join(", "),
        confidence: c.confidence,
        evidence: c.evidence_count,
      }));
      emitList(false, ["id", "title", "tags", "confidence", "evidence"], rows);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const reviewCommand = defineCommand({
  meta: { name: "review", description: "Review proposed session learnings interactively" },
  async run() {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const items = await fetchProposed(client);
      if (items.length === 0) {
        process.stdout.write("No proposed learnings — the review queue is empty.\n");
        return;
      }
      prompts.intro(`sk learnings review — ${items.length} proposal(s)`);
      let approved = 0;
      let rejected = 0;
      for (const [index, candidate] of items.entries()) {
        prompts.log.message(
          [
            `${pc.bold(`[${index + 1}/${items.length}]`)} ${pc.bold(candidate.title)}`,
            pc.dim(
              `tags: ${(candidate.tags ?? []).join(", ") || "—"} · confidence: ${candidate.confidence} · evidence: ${candidate.evidence_count}`,
            ),
            "",
            candidate.body,
            ...(candidate.pitfalls && candidate.pitfalls.length > 0
              ? ["", "Pitfalls:", ...candidate.pitfalls.map((p) => `- ${p}`)]
              : []),
          ].join("\n"),
        );
        const action = await prompts.select({
          message: "Decision?",
          options: [
            { value: "approve", label: "Approve → active skill (lands in the next briefing)" },
            { value: "edit", label: "Edit title/body, then approve" },
            { value: "reject", label: "Reject (same learning is never re-proposed)" },
            { value: "skip", label: "Skip for now" },
            { value: "quit", label: "Quit review" },
          ],
        });
        if (prompts.isCancel(action) || action === "quit") break;
        if (action === "skip") continue;
        if (action === "reject") {
          const reason = await prompts.text({
            message: "Reason (optional):",
            defaultValue: "",
          });
          await client.rejectSkillCandidate(candidate.id, {
            ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
          });
          rejected += 1;
          prompts.log.success("rejected");
          continue;
        }
        let title = candidate.title;
        let body = candidate.body;
        if (action === "edit") {
          const nextTitle = await prompts.text({ message: "Title:", initialValue: title });
          if (prompts.isCancel(nextTitle)) continue;
          const nextBody = await prompts.text({ message: "Body:", initialValue: body });
          if (prompts.isCancel(nextBody)) continue;
          title = String(nextTitle);
          body = String(nextBody);
        }
        const result = await client.approveSkillCandidate(candidate.id, {
          title,
          body,
          // Straight to active: the review IS the human gate, and only
          // active skills reach the session briefing.
          status: "active",
        });
        approved += 1;
        prompts.log.success(
          `approved → skill ${String((result as { skill_id?: unknown }).skill_id ?? "")}`,
        );
      }
      prompts.outro(`${approved} approved · ${rejected} rejected`);
    } catch (err) {
      reportCommandError(err, { json: false });
    }
  },
});

export const learningsCommand = defineCommand({
  meta: {
    name: "learnings",
    description: "Review learnings captured from coding-agent sessions",
  },
  subCommands: {
    review: reviewCommand,
    list: listCommand,
  },
});
