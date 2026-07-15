import type { PersonaProbe } from "../slash.ts";

export type TaskActionCategory =
  | "start"
  | "authoring"
  | "execution"
  | "review"
  | "context"
  | "admin"
  | "utility";

export type TaskActionInvocation =
  | { kind: "slash"; command: string }
  | { kind: "prompt"; prompt: string }
  | { kind: "builtin"; name: "launcher" };

export interface TaskAction {
  id: string;
  key?: string | undefined;
  label: string;
  detail: string;
  description: string;
  category: TaskActionCategory;
  aliases?: readonly string[] | undefined;
  requires?: string | undefined;
  requiresTarget?: "connector" | "workflow" | "any" | undefined;
  requiresPreview?: boolean | undefined;
  noviceSafe?: boolean | undefined;
  powerOnly?: boolean | undefined;
  invoke: TaskActionInvocation;
}

export const WORKFLOW_STARTER_PROMPT = [
  "I want to build a workflow.",
  "Guide me one question at a time.",
  "Ask first which connectors are involved, what should trigger it, and what success looks like.",
  "Preview before commit.",
].join("\n");

export const CONNECTOR_STARTER_PROMPT = [
  "I want to create a connector.",
  "Suggest a template only if it clearly helps, but do not require one.",
  "Ask me one high-signal question at a time and probe before saving.",
].join("\n");

export const MANAGE_STARTER_PROMPT = [
  "I want to inspect or manage existing tenant resources.",
  "Ground me in the workflows, connectors, runs, or credentials that actually exist first.",
  "If a matching write action exists, use it with confirmation instead of inventing off-surface fallbacks.",
].join("\n");

export const SURFACE_HELP_STARTER_PROMPT = [
  "I want help using sk surfaces - the CLI, MCP, the HTTP API, schedules, or Google Chat.",
  "Answer from actual engine behavior and exposed routes only.",
  "If something is not exposed in this conversation surface, say that plainly.",
].join("\n");

export const TRIAGE_STARTER_PROMPT = [
  "Walk through each failure in the engine health digest you were just given.",
  "For each one, triage the root cause and propose the smallest fix.",
  "Validate before committing any draft change.",
  "Act only on the issues in the digest — do not invent problems beyond it.",
].join("\n");

export const REVIEW_LEARNINGS_STARTER_PROMPT = [
  "Review the proposed session learnings with me.",
  "List them via list_skill_candidates (status proposed, pattern_kind session_learning) and walk through each one — what it captures and why it was proposed.",
  "Approve a candidate via approve_skill_candidate only after I explicitly confirm it; use the reject route when I decline one.",
  "Never approve or reject a candidate on your own initiative.",
].join("\n");

export const TASK_ACTIONS: readonly TaskAction[] = [
  {
    id: "probe-draft",
    label: "Probe connector draft",
    detail: "/probe",
    description: "Run the current connector draft probe and stream the tool result in chat.",
    category: "authoring",
    aliases: ["probe", "test connector", "connector probe"],
    requires: "conversation:write",
    requiresTarget: "connector",
    invoke: { kind: "slash", command: "/probe" },
  },
  {
    id: "preview-draft",
    label: "Preview workflow draft",
    detail: "/preview",
    description: "Dry-run the current workflow draft and surface warnings before commit.",
    category: "authoring",
    aliases: ["preview", "dry run", "dry-run"],
    requires: "conversation:write",
    requiresTarget: "workflow",
    invoke: { kind: "slash", command: "/preview" },
  },
  {
    id: "resume-recent",
    key: "1",
    label: "Resume recent",
    detail: "/resume",
    description: "Reattach to a previous conversation and continue from the active checkpoint.",
    category: "start",
    aliases: ["resume", "continue", "recent"],
    requires: "conversation:list",
    noviceSafe: true,
    invoke: { kind: "slash", command: "/resume" },
  },
  {
    id: "create-connector",
    key: "2",
    label: "Create a connector",
    detail: "guided setup",
    description: "Start a conversational connector setup with credential probing before save.",
    category: "authoring",
    aliases: ["connector", "credential", "integration", "onboard"],
    requires: "conversation:write",
    noviceSafe: true,
    invoke: { kind: "prompt", prompt: CONNECTOR_STARTER_PROMPT },
  },
  {
    id: "build-workflow",
    key: "3",
    label: "Build a workflow",
    detail: "guided authoring",
    description:
      "Create or update a workflow through inspect, validate, preview, and commit gates.",
    category: "authoring",
    aliases: ["workflow", "flow", "draft", "build"],
    requires: "conversation:write",
    noviceSafe: true,
    invoke: { kind: "prompt", prompt: WORKFLOW_STARTER_PROMPT },
  },
  {
    id: "inspect-tenant",
    key: "4",
    label: "Inspect tenant state",
    detail: "workflows - connectors - runs",
    description: "Ask the agent to ground the session in existing tenant resources before changes.",
    category: "context",
    aliases: ["inspect", "manage", "resources", "state"],
    requires: "conversation:write",
    noviceSafe: true,
    invoke: { kind: "prompt", prompt: MANAGE_STARTER_PROMPT },
  },
  {
    id: "surface-help",
    key: "5",
    label: "API / MCP / chat help",
    detail: "surface guidance",
    description: "Explain which capability belongs in CLI, MCP, API, schedules, or chat surfaces.",
    category: "utility",
    aliases: ["help", "surfaces", "mcp", "api", "chat"],
    noviceSafe: true,
    invoke: { kind: "prompt", prompt: SURFACE_HELP_STARTER_PROMPT },
  },
  {
    id: "check-accessible-work",
    key: "4",
    label: "Check accessible work",
    detail: "status - workflows - runs",
    description: "Show the work this persona can access without exposing admin-only tenant state.",
    category: "context",
    aliases: ["accessible", "my work", "runs"],
    requires: "conversation:write",
    noviceSafe: true,
    invoke: {
      kind: "prompt",
      prompt:
        "Show the workflows, runs, and connector context I can access. Answer from the tenant snapshot first and ask before taking any write action.",
    },
  },
  {
    id: "task-launcher",
    label: "Open action launcher",
    detail: "/actions",
    description: "Browse the stable task catalog with persona-aware permissions.",
    category: "utility",
    aliases: ["actions", "launcher", "tasks"],
    noviceSafe: true,
    invoke: { kind: "builtin", name: "launcher" },
  },
  {
    id: "run-workflow",
    label: "Run a workflow",
    detail: "guided execution",
    description: "Pick a workflow, confirm inputs, and execute through the governed surface.",
    category: "execution",
    aliases: ["run", "execute", "start execution"],
    requires: "conversation:write",
    invoke: {
      kind: "prompt",
      prompt:
        "I want to run a workflow. Help me choose from workflows I can access, collect required inputs, and ask for confirmation before execution.",
    },
  },
  {
    id: "triage-digest-failures",
    label: "Fix failures",
    detail: "guided triage",
    description:
      "Triage the failures in the startup health digest and propose the smallest validated fix for each.",
    category: "execution",
    aliases: ["fix failures", "triage", "health digest", "needs attention"],
    requires: "conversation:write",
    noviceSafe: true,
    invoke: { kind: "prompt", prompt: TRIAGE_STARTER_PROMPT },
  },
  {
    id: "review-learnings",
    label: "Review proposed learnings",
    detail: "curation",
    description:
      "Walk through proposed session learnings and approve or reject each one with explicit confirmation.",
    category: "review",
    aliases: ["learnings", "review learnings"],
    requires: "skill:read",
    invoke: { kind: "prompt", prompt: REVIEW_LEARNINGS_STARTER_PROMPT },
  },
  {
    id: "repair-failed-run",
    label: "Repair latest failure",
    detail: "diagnose - edit - validate",
    description: "Diagnose the latest failed execution and route through repair-in-chat gates.",
    category: "execution",
    aliases: ["repair", "diagnose", "failure", "fix run"],
    requires: "conversation:write",
    invoke: {
      kind: "prompt",
      prompt:
        "Diagnose the latest failed workflow execution I can access, explain the root cause, then propose the smallest repair. Validate before committing any draft update.",
    },
  },
  {
    id: "show-approvals",
    label: "Review approvals",
    detail: "/approvals",
    description:
      "Inspect approval history and pending governance decisions for the active conversation.",
    category: "review",
    aliases: ["approvals", "approval", "confirmations"],
    requires: "conversation:read",
    invoke: { kind: "slash", command: "/approvals" },
  },
  {
    id: "runtime-status",
    label: "Runtime status",
    detail: "/status",
    description: "Show session, persona, tenant, and engine connection state.",
    category: "utility",
    aliases: ["status", "session", "connection"],
    invoke: { kind: "slash", command: "/status" },
  },
  {
    id: "setup-readiness",
    label: "Setup readiness",
    detail: "/setup",
    description: "Inspect engine setup diagnostics when this persona can read them.",
    category: "admin",
    aliases: ["setup", "diagnostics", "readiness"],
    requires: "identity:read",
    invoke: { kind: "slash", command: "/setup" },
  },
  {
    id: "connector-onboarding",
    label: "Connector onboarding",
    detail: "/onboard",
    description: "Launch the interactive template, credential, probe, and save wizard.",
    category: "authoring",
    aliases: ["onboard", "wizard", "template picker"],
    requires: "connector:write",
    invoke: { kind: "slash", command: "/onboard" },
  },
  {
    id: "inspect-draft",
    label: "Inspect current draft",
    detail: "/draft",
    description: "Show current connector/workflow draft, checkpoints, and latest preview warnings.",
    category: "authoring",
    aliases: ["draft", "checkpoint", "preview warnings"],
    requires: "conversation:read",
    invoke: { kind: "slash", command: "/draft" },
  },
  {
    id: "show-context",
    label: "Show conversation context",
    detail: "/context",
    description: "Inspect active target, tenant snapshot, memory, skills, and scoped knowledge.",
    category: "context",
    aliases: ["context", "snapshot", "memory"],
    requires: "conversation:read",
    invoke: { kind: "slash", command: "/context" },
  },
  {
    id: "permissions",
    label: "Show permissions",
    detail: "/permissions",
    description: "List the permissions granted to the current persona.",
    category: "utility",
    aliases: ["permissions", "rbac", "access"],
    invoke: { kind: "slash", command: "/permissions" },
  },
];

export function taskActionsForPersona(probe: PersonaProbe): readonly TaskAction[] {
  return TASK_ACTIONS.filter((action) => !action.requires || probe.allows(action.requires));
}

export function taskActionsForContext(
  probe: PersonaProbe,
  context?:
    | {
        resumeSummary?: {
          active_target: { kind: "connector" | "workflow" | "none" };
          last_successful_preview: string | null;
        } | null;
      }
    | undefined,
): readonly TaskAction[] {
  const targetKind = context?.resumeSummary?.active_target.kind ?? "none";
  const hasPreview = Boolean(context?.resumeSummary?.last_successful_preview);
  return taskActionsForPersona(probe).filter((action) => {
    if (action.requiresTarget === "connector" && targetKind !== "connector") return false;
    if (action.requiresTarget === "workflow" && targetKind !== "workflow") return false;
    if (action.requiresTarget === "any" && targetKind === "none") return false;
    if (action.requiresPreview && !hasPreview) return false;
    return true;
  });
}

export function starterTaskActionsForPersona(
  personaLabel: string,
  probe?: PersonaProbe | undefined,
): readonly TaskAction[] {
  const label = personaLabel.trim().toLowerCase();
  const ids =
    label === "portal" || label === "enduser"
      ? [
          "resume-recent",
          "create-connector",
          "build-workflow",
          "check-accessible-work",
          "surface-help",
        ]
      : ["resume-recent", "create-connector", "build-workflow", "inspect-tenant", "surface-help"];
  const actions = ids
    .map((id) => TASK_ACTIONS.find((action) => action.id === id))
    .filter((action): action is TaskAction => Boolean(action));
  return probe
    ? actions.filter((action) => !action.requires || probe.allows(action.requires))
    : actions;
}

export function normalizeActionText(value: string): string {
  return value.trim().toLowerCase().replace(/^\/+/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function findTaskActionById(id: string): TaskAction | undefined {
  return TASK_ACTIONS.find((action) => action.id === id);
}

export function resolveTaskActionSuggestion(value: string): TaskAction | undefined {
  const normalized = normalizeActionText(value);
  if (!normalized) return undefined;
  return TASK_ACTIONS.find((action) => {
    const slash =
      action.invoke.kind === "slash"
        ? normalizeActionText(action.invoke.command)
        : action.invoke.kind === "builtin"
          ? normalizeActionText(action.invoke.name)
          : "";
    return (
      normalizeActionText(action.id) === normalized ||
      normalizeActionText(action.label) === normalized ||
      slash === normalized ||
      action.aliases?.some((alias) => normalizeActionText(alias) === normalized)
    );
  });
}

export function searchTaskActions(
  query: string,
  actions: readonly TaskAction[],
  limit = 8,
): readonly TaskAction[] {
  const normalized = normalizeActionText(query);
  if (!normalized) return actions.slice(0, limit);
  const scored = actions
    .map((action) => {
      const haystack = [
        action.id,
        action.label,
        action.detail,
        action.description,
        ...(action.aliases ?? []),
      ]
        .map(normalizeActionText)
        .join(" ");
      const exact =
        normalizeActionText(action.id) === normalized ||
        normalizeActionText(action.label) === normalized;
      const prefix = haystack.split(" ").some((part) => part.startsWith(normalized));
      const contains = haystack.includes(normalized);
      const score = exact ? 0 : prefix ? 1 : contains ? 2 : 10;
      return { action, score };
    })
    .filter((entry) => entry.score < 10)
    .sort((a, b) => a.score - b.score || a.action.label.localeCompare(b.action.label));
  return scored.slice(0, limit).map((entry) => entry.action);
}
