import pc from "picocolors";

export interface AutomationReadiness {
  environment: "dev" | "prod";
  workflow_version_id: string | null;
  state: "eligible" | "repair_required" | "verification_unavailable";
  issues: Array<{ step_id: string; code: string }>;
  repair_guidance: Array<{ step_id: string; code: string; instruction: string }>;
}

export function formatAutomationReadiness(readiness: AutomationReadiness | undefined): string {
  if (!readiness) return "";
  if (readiness.state === "eligible")
    return `${pc.green("automation:")} recurring runs can be approved (${readiness.environment}); a person approves them in Cockpit.\n`;
  if (readiness.state === "verification_unavailable")
    return `${pc.yellow("automation:")} readiness could not be verified (${readiness.environment}); check it in Cockpit before relying on a schedule.\n`;
  const guided = new Set(
    readiness.repair_guidance.map((entry) => `${entry.step_id}:${entry.code}`),
  );
  const lines = [
    ...readiness.repair_guidance.map(
      (entry) => `  - ${pc.bold(entry.step_id)} ${pc.dim(`(${entry.code})`)}: ${entry.instruction}`,
    ),
    ...readiness.issues
      .filter((issue) => !guided.has(`${issue.step_id}:${issue.code}`))
      .map((issue) => `  - ${pc.bold(issue.step_id)} ${pc.dim(`(${issue.code})`)}`),
  ];
  const onlyConnectors =
    readiness.issues.length === 0 &&
    readiness.repair_guidance.length > 0 &&
    readiness.repair_guidance.every((entry) => entry.code === "connector_unavailable");
  return (
    `${pc.red("automation: repair required")} (${readiness.environment}) — no approval can unblock ` +
    `scheduled or webhook runs of this version until ${onlyConnectors ? "these connectors are ready" : "these steps change"}:\n` +
    `${lines.join("\n")}\n`
  );
}
