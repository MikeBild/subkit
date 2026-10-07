import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Gauge,
  History,
  LayoutTemplate,
  Plug,
  Sparkles,
  SquarePen,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { useAttention } from "@/app/use-attention";
import {
  joinNames,
  missingConnectors,
  solutionNeeds,
  solutionText,
} from "@/components/cockpit/create-template-model";
import { ChoiceCards } from "@/components/cockpit/patterns";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useWorkflowCategories } from "@/queries/mention-sources";
import { chatStarters, type StarterIcon } from "./chat-start-model";

type RecipePack = components["schemas"]["RecipePackResponse"];

const ICONS: Record<StarterIcon, ReactNode> = {
  failing: <Activity />,
  usage: <Gauge />,
  solution: <LayoutTemplate />,
  knowledge: <BookOpen />,
  catalog: <Workflow />,
  capabilities: <Sparkles />,
  create: <SquarePen />,
  connect: <Plug />,
  run: <History />,
};

export function ChatStart({ onPick }: { onPick(prompt: string): void }) {
  const { t, locale } = useI18n();
  const permissions = useSession().permissions;
  const canWorkflows = permissions.includes("workflow:read");
  const attention = useAttention(permissions);
  const catalog = useWorkflowCategories(canWorkflows);
  const solutions = useQuery({
    queryKey: ["recipe-packs", "solutions"],
    enabled: canWorkflows,
    staleTime: 300_000,
    queryFn: () => apiRequest<RecipePack>("/v1/recipe-packs/solutions"),
  });
  const knowledge = useQuery({
    queryKey: ["chat", "starter-knowledge"],
    enabled: permissions.includes("knowledge:read"),
    staleTime: 300_000,
    queryFn: () =>
      apiRequest<{ items: { slug: string; name: string }[] }>("/v1/knowledge-sources?limit=20"),
  });
  if (
    (attention.enabled && attention.query.isLoading) ||
    catalog.isLoading ||
    solutions.isLoading ||
    knowledge.isLoading
  )
    return null;
  const tag = LOCALE_TAGS[locale];
  const starters = chatStarters(
    {
      attention: attention.query.data?.items ?? [],
      usage: permissions.includes("stats:read"),
      solutions: (solutions.data?.recipes ?? []).map((entry) => {
        const text = solutionText(entry, t);
        return {
          slug: entry.recipe_slug,
          title: text.title,
          line: text.line,
          needs: joinNames(solutionNeeds(entry), tag),
          ready: missingConnectors(entry).length === 0,
        };
      }),
      knowledge: knowledge.data?.items ?? [],
      categories: catalog.categories,
    },
    t,
  );
  return (
    <div className="grid gap-3" data-testid="chat-starters">
      <p className="text-sm text-muted-foreground">{t("chat.start.label")}</p>
      <ChoiceCards
        items={starters.map((starter) => ({
          icon: ICONS[starter.icon],
          title: starter.title,
          line: starter.line,
          onSelect: () => onPick(starter.prompt),
          testId: `chat-starter-${starter.id}`,
        }))}
      />
    </div>
  );
}
