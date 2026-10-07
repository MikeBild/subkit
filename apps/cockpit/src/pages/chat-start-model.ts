import type { TranslationKey } from "@/lib/i18n";
import { categoryMentionToken } from "@/lib/mentions";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const MIN_STARTERS = 4;
export const MAX_STARTERS = 6;

export type StarterIcon =
  | "failing"
  | "usage"
  | "solution"
  | "knowledge"
  | "catalog"
  | "capabilities"
  | "create"
  | "connect"
  | "run";

export interface ChatStarter {
  id: string;
  icon: StarterIcon;
  title: string;
  line: string;
  prompt: string;
}

export interface StarterAttention {
  class: string;
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
}

function failingWorkflow(attention: readonly StarterAttention[]) {
  for (const item of attention) {
    if (item.class === "failing" && item.subject?.kind === "workflow" && item.subject.name) {
      return { id: item.subject.id, name: item.subject.name };
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
      icon: "failing",
      title: t("chat.starter.failing.title"),
      line: t("chat.starter.failing.line", { name: failing.name }),
      prompt: t("chat.starter.failing.prompt", { name: failing.name }),
    });
  }
  if (sources.usage) {
    starters.push({
      id: "usage",
      icon: "usage",
      title: t("chat.starter.usage.title"),
      line: t("chat.starter.usage.line"),
      prompt: t("chat.starter.usage.prompt"),
    });
  }
  const solution = pickSolution(sources.solutions);
  if (solution) {
    starters.push({
      id: `solution-${solution.slug}`,
      icon: "solution",
      title: solution.title,
      line: t("chat.starter.solution.line", { needs: solution.needs }),
      prompt: t("chat.starter.solution.prompt", { title: solution.title, line: solution.line }),
    });
  }
  const knowledge = pickKnowledge(sources.knowledge);
  if (knowledge) {
    starters.push({
      id: `knowledge-${knowledge.slug}`,
      icon: "knowledge",
      title: t("chat.starter.knowledge.title"),
      line: t("chat.starter.knowledge.line", { name: knowledge.name }),
      prompt: t("chat.starter.knowledge.prompt", { name: knowledge.name }),
    });
  }
  const category = pickCategory(sources.categories);
  if (category) {
    starters.push({
      id: `catalog-${category.category}`,
      icon: "catalog",
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
      icon: "capabilities",
      title: t("chat.starter.capabilities"),
      line: t("chat.starter.capabilities.line"),
      prompt: t("chat.starter.capabilities"),
    },
    {
      id: "create",
      icon: "create",
      title: t("chat.starter.create"),
      line: t("create.workflow.chatLine"),
      prompt: t("create.workflow.prompt"),
    },
    {
      id: "connect",
      icon: "connect",
      title: t("chat.starter.connect"),
      line: t("create.connector.chatLine"),
      prompt: t("create.connector.prompt"),
    },
    {
      id: "run",
      icon: "run",
      title: t("chat.starter.lastRun"),
      line: t("chat.starter.lastRun.line"),
      prompt: t("chat.starter.lastRun"),
    },
  ];
  for (const filler of fillers) {
    if (starters.length >= MIN_STARTERS) break;
    starters.push(filler);
  }
  return starters.slice(0, MAX_STARTERS);
}
