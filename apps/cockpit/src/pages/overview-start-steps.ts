import type { Bootstrap } from "@/api/client";
import { apiAccessHref, chatNewHref, connectorsHref, peopleHref, workflowsHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

type StartStepId = keyof Omit<Bootstrap["start_steps"], "hidden">;

export interface StartStepEntry {
  id: StartStepId;
  title: TranslationKey;
  line: TranslationKey;
  href: string;
  done: boolean;
}

const STEPS: readonly {
  id: StartStepId;
  title: TranslationKey;
  line: TranslationKey;
  href(can: (permission: string) => boolean): string | null;
}[] = [
  {
    id: "connector",
    title: "startSteps.connector.title",
    line: "startSteps.connector.line",
    href: (can) => (can("connector:write") ? connectorsHref() : null),
  },
  {
    id: "workflow",
    title: "startSteps.workflow.title",
    line: "startSteps.workflow.line",
    href: (can) => (can("conversation:write") ? chatNewHref() : null),
  },
  {
    id: "run",
    title: "startSteps.run.title",
    line: "startSteps.run.line",
    href: (can) => (can("workflow:read") ? workflowsHref() : null),
  },
  {
    id: "people",
    title: "startSteps.people.title",
    line: "startSteps.people.line",
    href: (can) => (can("identity:write") ? peopleHref() : null),
  },
  {
    id: "client",
    title: "startSteps.client.title",
    line: "startSteps.client.line",
    href: (can) =>
      can("mcp_oauth_client:read")
        ? apiAccessHref("clients")
        : can("api_key:read")
          ? apiAccessHref("keys")
          : null,
  },
];

export function startSteps(
  session: Pick<Bootstrap, "start_steps" | "permissions">,
): StartStepEntry[] {
  const can = (permission: string) => session.permissions.includes(permission);
  return STEPS.flatMap((step) => {
    const href = step.href(can);
    return href
      ? [
          {
            id: step.id,
            title: step.title,
            line: step.line,
            href,
            done: session.start_steps[step.id],
          },
        ]
      : [];
  });
}
