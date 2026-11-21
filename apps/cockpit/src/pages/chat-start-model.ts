import type { TranslationKey } from "@/lib/i18n";
import { categoryMentionToken } from "@/lib/mentions";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

interface StarterGates {
  workflows: boolean;
  solutions: boolean;
  knowledge: boolean;
  usage: boolean;
  intake: boolean;
}

export function starterGates(permissions: readonly string[]): StarterGates {
  return {
    workflows: permissions.includes("workflow:read"),
    solutions: permissions.includes("connector:read"),
    knowledge: permissions.includes("knowledge:read"),
    usage: permissions.includes("stats:read"),
    intake: permissions.includes("intake:read"),
  };
}

export function retryStarterQuery(failures: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return failures < 1;
}

export const MIN_STARTERS = 4;
export const MAX_STARTERS = 10;
export const CHIP_STARTERS = 4;

export function startersVisible(chat: {
  messages: number;
  sending: boolean;
  optimistic: boolean;
  failed: boolean;
  seeded: boolean;
}): boolean {
  return chat.messages === 0 && !chat.sending && !chat.optimistic && !chat.failed && !chat.seeded;
}

export function starterChips<Starter>(
  starters: readonly Starter[],
  expanded: boolean,
): { shown: readonly Starter[]; hidden: number } {
  const shown = expanded ? starters : starters.slice(0, CHIP_STARTERS);
  return { shown, hidden: starters.length - shown.length };
}

export interface ChatStarter {
  id: string;
  title: string;
  line: string;
  prompt: string;
}

export interface StarterAttention {
  class: string;
  counts?: { consecutive_failures?: number };
  subject: { kind: string; id: string; name: string | null } | null;
}

export interface StarterSolution {
  slug: string;
  title: string;
  line: string;
  needs: string;
  ready: boolean;
}

export interface StarterSources {
  attention: readonly StarterAttention[];
  usage: boolean;
  solutions: readonly StarterSolution[];
  knowledge: readonly { slug: string; name: string }[];
  categories: readonly { category: string; count: number }[];
  intake: { category: string; collected: number } | null;
}

function failingWorkflow(attention: readonly StarterAttention[]) {
  for (const item of attention) {
    if (item.class === "failing" && item.subject?.kind === "workflow" && item.subject.name) {
      return {
        id: item.subject.id,
        name: item.subject.name,
        failures: item.counts?.consecutive_failures,
      };
    }
  }
  return null;
}

function pickSolution(solutions: readonly StarterSolution[]): StarterSolution | null {
  return solutions.find((solution) => solution.ready) ?? solutions[0] ?? null;
}

function pickKnowledge(knowledge: StarterSources["knowledge"]) {
  return [...knowledge].sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  )[0];
}

function pickCategory(categories: StarterSources["categories"]) {
  return [...categories]
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))[0];
}

export function chatStarters(sources: StarterSources, t: Translate): ChatStarter[] {
  const starters: ChatStarter[] = [];
  const failing = failingWorkflow(sources.attention);
  if (failing) {
    starters.push({
      id: `failing-${failing.id}`,
      title: t("chat.starter.failing.title"),
      line:
        failing.failures !== undefined && Number.isInteger(failing.failures) && failing.failures > 0
          ? t(
              failing.failures === 1
                ? "chat.starter.failing.count.one"
                : "chat.starter.failing.count.other",
              { name: failing.name, count: failing.failures },
            )
          : t("chat.starter.failing.line", { name: failing.name }),
      prompt: t("chat.starter.failing.prompt", { name: failing.name }),
    });
  }
  if (sources.usage) {
    starters.push({
      id: "usage",
      title: t("chat.starter.usage.title"),
      line: t("chat.starter.usage.line"),
      prompt: t("chat.starter.usage.prompt"),
    });
  }
  const solution = pickSolution(sources.solutions);
  if (solution) {
    starters.push({
      id: `solution-${solution.slug}`,
      title: solution.title,
      line: t("chat.starter.solution.line", { needs: solution.needs }),
      prompt: t("chat.starter.solution.prompt", { title: solution.title, line: solution.line }),
    });
  }
  const knowledge = pickKnowledge(sources.knowledge);
  if (knowledge) {
    starters.push({
      id: `knowledge-${knowledge.slug}`,
      title: t("chat.starter.knowledge.title"),
      line: t("chat.starter.knowledge.line", { name: knowledge.name }),
      prompt: t("chat.starter.knowledge.prompt", { name: knowledge.name }),
    });
  }
  if (sources.intake) {
    const prompt = t("intake.chatPrompt", { collection: sources.intake.category });
    starters.push({
      id: `intake-${sources.intake.category}`,
      title: t("intake.starterTitle", { category: sources.intake.category }),
      line: t("intake.starterDescription"),
      prompt,
    });
  }
  const category = pickCategory(sources.categories);
  if (category) {
    starters.push({
      id: `catalog-${category.category}`,
      title: t("chat.starter.catalog.title"),
      line: t(
        category.count === 1 ? "chat.starter.catalog.line.one" : "chat.starter.catalog.line.other",
        { category: category.category, count: category.count },
      ),
      prompt: t("chat.starter.categoryPrompt", { token: categoryMentionToken(category.category) }),
    });
  }
  const fillers: ChatStarter[] = [
    {
      id: "capabilities",
      title: t("chat.starter.capabilities"),
      line: t("chat.starter.capabilities.line"),
      prompt: t("chat.starter.capabilities"),
    },
    {
      id: "create",
      title: t("chat.starter.create"),
      line: t("create.workflow.chatLine"),
      prompt: t("create.workflow.prompt"),
    },
    {
      id: "connect",
      title: t("chat.starter.connect"),
      line: t("create.connector.chatLine"),
      prompt: t("create.connector.prompt"),
    },
    {
      id: "run",
      title: t("chat.starter.lastRun"),
      line: t("chat.starter.lastRun.line"),
      prompt: t("chat.starter.lastRun"),
    },
  ];
  starters.push(...fillers);
  return starters.slice(0, MAX_STARTERS);
}
