import type { DraftDocument } from "./types.ts";

export type TurnIntent =
  | "author_connector"
  | "author_workflow"
  | "tenant_read"
  | "tenant_write"
  | "product_help"
  | "surface_help"
  | "unsupported_or_unavailable";

export interface TurnRoutingPlan {
  intent: TurnIntent;
  confidence: "high" | "medium";
  action: string;
  question: string | null;
  required_grounding: string[];
  notes: string[];
  forbidden_fallbacks: string[];
}

function normalize(text: string | null | undefined): string {
  return text?.trim().toLowerCase() ?? "";
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function fallbackList(): string[] {
  return ["support", "web_ui", "admin_console", "direct_database"];
}

const MCP_PATTERNS = [/\bmcp\b/, /claude[\s-]?code/, /model context protocol/] as const;
const CHAT_SURFACE_PATTERNS = [
  /\bgoogle chat\b/,
  /\bslack\b/,
  /\bteams\b/,
  /\bchat interface\b/,
] as const;
const HTTP_API_PATTERNS = [
  /\bhttp\b/,
  /\brest\b/,
  /\bapi\b/,
  /openapi/,
  /curl/,
  /\/docs\b/,
  /\/openapi\.json/,
] as const;
const SCHEDULE_PATTERNS = [/\bschedule(?:d)?\b/, /\bcron\b/] as const;
const PERMISSION_PATTERNS = [/\bpermission/, /\brbac\b/, /\brole\b/, /what am i allowed/] as const;
const CAPABILITY_PATTERNS = [
  /what can i do/,
  /what do i do next/,
  /what is possible/,
  /what's possible/,
] as const;
const CONNECTOR_PATTERNS = [/\bconnector\b/, /\bapi spec\b/, /openapi/, /\bimport docs\b/] as const;
const WORKFLOW_PATTERNS = [/\bbuild(?: a)? workflow\b/, /\bworkflow\b/] as const;
const LIST_PATTERNS = [/\blist\b/, /\bshow\b/, /\bwhat\b/, /\bwhich\b/, /\binspect\b/] as const;
const DELETE_PATTERNS = [
  /\bdelete\b/,
  /\bremove\b/,
  /\brevoke\b/,
  /\babort\b/,
  /\breplay\b/,
  /\brestore\b/,
] as const;

export function planTurnRouting(args: {
  draft: DraftDocument | null | undefined;
  user_message: string | null | undefined;
}): TurnRoutingPlan {
  const text = normalize(args.user_message);
  const mode = args.draft?.mode ?? "onboarding";

  if (text.length === 0) {
    if (mode === "connector_authoring") {
      return {
        intent: "author_connector",
        confidence: "medium",
        action: "Continue connector authoring and ask for the single most important missing field.",
        question: "Which connector are we creating and how should it authenticate?",
        required_grounding: ["inspect_connector_draft", "validate_connector_draft"],
        notes: ["Stay in connector setup until the draft is grounded and probed."],
        forbidden_fallbacks: fallbackList(),
      };
    }
    if (mode === "workflow_authoring") {
      return {
        intent: "author_workflow",
        confidence: "medium",
        action:
          "Continue workflow authoring and ask for the trigger, involved connectors, or expected result.",
        question: "What should trigger this workflow, and what should a successful run produce?",
        required_grounding: ["inspect_workflow_draft", "validate_draft"],
        notes: ["Keep the workflow grounded in real connectors and preview before commit."],
        forbidden_fallbacks: fallbackList(),
      };
    }
    return {
      intent: "surface_help",
      confidence: "medium",
      action:
        "Orient the user around the next concrete job in sk: resume work, create a connector, build a workflow, inspect tenant state, or ask about API/MCP/chat surfaces.",
      question: "Which job should we do next?",
      required_grounding: ["get_engine_status", "list_workflows", "list_connectors"],
      notes: ["Prefer capability-grounded suggestions over generic onboarding prose."],
      forbidden_fallbacks: fallbackList(),
    };
  }

  const asksHow =
    /^(how|what|can|where|when|why)\b/.test(text) ||
    text.includes("how to") ||
    text.includes("how do i");
  const mentionsWorkflows = /\bworkflow\b/.test(text);
  const mentionsConnectors = /\bconnector\b/.test(text);
  const containsUrl = /\bhttps?:\/\/\S+/.test(text);
  const looksLikeSpec =
    text.startsWith("curl ") ||
    text.trimStart().startsWith("{") ||
    /^openapi:/m.test(text) ||
    /^swagger:/m.test(text);

  if (/\barchive\b/.test(text) && mentionsWorkflows) {
    return {
      intent: "unsupported_or_unavailable",
      confidence: "high",
      action:
        "Explain plainly that workflow archiving is not exposed in this conversation surface. If the user wants cleanup, offer delete_workflow when that is the intended operation.",
      question: null,
      required_grounding: ["list_workflows", "delete_workflow"],
      notes: [
        "Do not claim workflow deletion is unavailable.",
        "Do not invent an archive UI, support path, or database workaround.",
      ],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (matchesAny(text, MCP_PATTERNS)) {
    return {
      intent: "surface_help",
      confidence: "high",
      action:
        "Explain MCP using Subkit's actual transports: Streamable HTTP on `/mcp`, plus the stdio proxy via `subkit mcp`. Do not mention the deprecated SSE MCP transport.",
      question: null,
      required_grounding: ["docs/03-input-surfaces.md", "docs/03-input-surfaces.md"],
      notes: [
        "Keep the answer operational and surface-aware.",
        "If exact client configuration is unknown, say what is confirmed and where the live contract lives.",
      ],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (matchesAny(text, CHAT_SURFACE_PATTERNS)) {
    return {
      intent: "surface_help",
      confidence: "high",
      action:
        "Explain chat-platform usage from the actual chat adapter design. For Google Chat as a conversation interface, ground the answer in chat workspace install plus `/subkit link` identity linking.",
      question: null,
      required_grounding: ["docs/03-input-surfaces.md"],
      notes: [
        "Treat Google Chat as a first-class conversation surface, not just an outbound connector target.",
      ],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (matchesAny(text, SCHEDULE_PATTERNS)) {
    if (asksHow) {
      return {
        intent: "surface_help",
        confidence: "high",
        action:
          "Explain that the engine has scheduled workflow execution, but schedule-management conversation tools are not exposed here today. Do not invent working schedule endpoints in chat.",
        question: null,
        required_grounding: ["docs/06-execution.md", "apps/cli/src/commands/schedules.ts"],
        notes: [
          "Use code truth over aspirational docs if route availability is unclear.",
          "Prefer stating the current surface limitation directly.",
        ],
        forbidden_fallbacks: fallbackList(),
      };
    }
    return {
      intent: "unsupported_or_unavailable",
      confidence: "high",
      action:
        "State that schedule management is not exposed in this conversation surface today. Do not claim that schedule creation, pause, or resume already works here unless a real tool exposes it.",
      question: null,
      required_grounding: ["apps/cli/src/commands/schedules.ts"],
      notes: ["Do not invent `/v1/schedules` usage in the chat response."],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (
    matchesAny(text, CAPABILITY_PATTERNS) ||
    (text.includes("what can i do") && !matchesAny(text, PERMISSION_PATTERNS))
  ) {
    return {
      intent: "surface_help",
      confidence: "high",
      action:
        "Ground the answer in real tenant state first, then suggest the next concrete job in sk: resume, create a connector, build a workflow, inspect existing resources, or ask about API/MCP/chat surfaces.",
      question: null,
      required_grounding: ["get_engine_status", "list_workflows", "list_connectors"],
      notes: [
        "Avoid generic onboarding menus when you can ground the answer in actual tenant state.",
      ],
      forbidden_fallbacks: fallbackList(),
    };
  }

  const asksAboutHttpSurface =
    text.includes("http api") ||
    text.includes("rest api") ||
    text.includes("openapi") ||
    text.includes("curl") ||
    text.includes("/docs") ||
    text.includes("/openapi.json") ||
    (matchesAny(text, HTTP_API_PATTERNS) && asksHow && text.includes("api"));

  if (asksAboutHttpSurface) {
    return {
      intent: "surface_help",
      confidence: "high",
      action:
        "Answer from the actual HTTP surface: the live OpenAPI contract is at `/openapi.json`, interactive docs at `/docs`, and exact REST paths must be grounded in the route definitions or live contract.",
      question: null,
      required_grounding: ["docs/03-input-surfaces.md", "docs/03-input-surfaces.md"],
      notes: [
        "Do not invent endpoints or request shapes when the route is not confirmed.",
        "If a capability exists in the engine but not in this chat surface, say so explicitly.",
      ],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (matchesAny(text, PERMISSION_PATTERNS)) {
    return {
      intent: "tenant_read",
      confidence: "high",
      action:
        "Ground the answer in the caller's actual identity or role information. Keep the summary compact and capability-focused; mention `/permissions` in sk when it is the fastest built-in path.",
      question: null,
      required_grounding: ["whoami", "list_roles", "get_role"],
      notes: ["Do not claim broad access without grounding it in a role or permission check."],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (matchesAny(text, DELETE_PATTERNS) && mentionsWorkflows) {
    return {
      intent: "tenant_write",
      confidence: "high",
      action:
        "If the target workflow is ambiguous, list_workflows first. Then use delete_workflow and rely on confirm-before-execution. After success, surface the audit id.",
      question: null,
      required_grounding: ["list_workflows", "delete_workflow"],
      notes: [
        "Do not say the delete tool is unavailable when the workflow delete tool exists.",
        "Do not suggest off-surface cleanup paths before checking the tool palette.",
      ],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (
    (matchesAny(text, LIST_PATTERNS) && mentionsWorkflows) ||
    text.includes("workflow") ||
    text.includes("execution") ||
    text.includes("connector") ||
    text.includes("tenant state")
  ) {
    if (matchesAny(text, CONNECTOR_PATTERNS) && !mentionsWorkflows && !mentionsConnectors) {
      const grounding = containsUrl
        ? [
            "match_connector_template_by_url",
            "suggest_connector_templates",
            "start_connector_from_description",
          ]
        : looksLikeSpec
          ? ["import_connector_from_spec", "start_connector_from_description"]
          : ["suggest_connector_templates", "start_connector_from_description"];
      return {
        intent: "author_connector",
        confidence: "medium",
        action:
          "Start connector authoring. Ask one high-signal question at a time and probe before saving.",
        question: "Which connector are we creating first?",
        required_grounding: grounding,
        notes: ["Offer templates only when they clearly accelerate the setup."],
        forbidden_fallbacks: fallbackList(),
      };
    }

    if (
      /\blist\b/.test(text) ||
      /\bshow\b/.test(text) ||
      text.includes("what workflows") ||
      text.includes("what connectors")
    ) {
      return {
        intent: "tenant_read",
        confidence: "medium",
        action:
          "Inspect real tenant state first. Use list/get tools and then suggest the next concrete operation on the returned resource.",
        question: null,
        required_grounding: [
          "get_engine_status",
          "list_workflows",
          "list_connectors",
          "list_executions",
        ],
        notes: ["Avoid generic onboarding lists when the tenant already has data you can inspect."],
        forbidden_fallbacks: fallbackList(),
      };
    }
  }

  if (mode === "connector_authoring" || matchesAny(text, CONNECTOR_PATTERNS)) {
    const connectorGrounding: string[] = [];
    if (containsUrl) connectorGrounding.push("match_connector_template_by_url");
    if (looksLikeSpec) connectorGrounding.push("import_connector_from_spec");
    connectorGrounding.push(
      "inspect_connector_draft",
      "validate_connector_draft",
      "probe_connector_draft",
    );
    return {
      intent: "author_connector",
      confidence: mode === "connector_authoring" ? "high" : "medium",
      action:
        "Drive connector authoring with one high-signal question at a time. Suggest a template only when it clearly helps and probe before saving.",
      question: "Which connector are we creating, and what auth method should we expect?",
      required_grounding: connectorGrounding,
      notes: ["Keep the user in connector setup until auth and endpoint details are grounded."],
      forbidden_fallbacks: fallbackList(),
    };
  }

  if (mode === "workflow_authoring" || matchesAny(text, WORKFLOW_PATTERNS)) {
    return {
      intent: "author_workflow",
      confidence: mode === "workflow_authoring" ? "high" : "medium",
      action:
        "Drive workflow authoring with one high-signal question at a time. Ground the trigger, involved systems, and expected result, then preview before commit.",
      question: "What should trigger this workflow, and what should success look like?",
      required_grounding: ["inspect_workflow_draft", "build_workflow", "dry_run_workflow"],
      notes: ["Keep the workflow grounded in real connectors and concrete output shape."],
      forbidden_fallbacks: fallbackList(),
    };
  }

  return {
    intent: "product_help",
    confidence: "medium",
    action:
      "Answer with confirmed Subkit product behavior, grounded in actual tools or docs. Prefer a short, operational answer plus the next concrete step in sk.",
    question: null,
    required_grounding: [
      "docs/03-input-surfaces.md",
      "docs/03-input-surfaces.md",
      "docs/03-input-surfaces.md",
    ],
    notes: ["Do not default to generic onboarding when the user is asking about product behavior."],
    forbidden_fallbacks: fallbackList(),
  };
}
