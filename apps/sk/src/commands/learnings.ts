import * as prompts from "@clack/prompts";
import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { fetchProposedLearnings, learningTarget } from "../lib/pending-learnings.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List proposed session learnings" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const items = await fetchProposedLearnings(client);
      if (args.json) {
        printJson(items);
        return;
      }
      const rows = items.map((c) => ({
        id: c.id,
        title: c.title,
        target: learningTarget(c),
        tags: (c.tags ?? []).join(", "),
        confidence: c.confidence,
        evidence: c.evidence_count,
      }));
      emitList(false, ["id", "title", "target", "tags", "confidence", "evidence"], rows);
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
      const items = await fetchProposedLearnings(client);
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
              `lands in: ${learningTarget(candidate)} · tags: ${(candidate.tags ?? []).join(", ") || "—"} · confidence: ${candidate.confidence} · evidence: ${candidate.evidence_count}`,
            ),
            "",
            candidate.body,
            ...(candidate.pitfalls && candidate.pitfalls.length > 0
              ? ["", "Pitfalls:", ...candidate.pitfalls.map((p) => `- ${p}`)]
              : []),
          ].join("\n"),
        );
        const fact = candidate.pattern_kind === "knowledge_learning";
        const action = await prompts.select({
          message: "Decision?",
          options: [
            {
              value: "approve",
              label: fact
                ? `Approve → new version of ${learningTarget(candidate).replace("knowledge: ", "")}`
                : "Approve → active skill (lands in the next briefing)",
            },
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
        const result = (await client.approveSkillCandidate(candidate.id, {
          title,
          body,
          ...(fact ? {} : { status: "active" }),
        })) as {
          skill_id?: string | null;
          knowledge?: { slug: string; version: number | null } | null;
        };
        approved += 1;
        prompts.log.success(
          result.knowledge
            ? `approved → ${result.knowledge.slug} v${result.knowledge.version ?? "?"}`
            : `approved → skill ${result.skill_id ?? ""}`,
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
