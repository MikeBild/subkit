import { useParams, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useSession } from "@/app/session";
import { Screen } from "@/components/cockpit/patterns/screen";
import { ForbiddenState } from "@/components/failure-state";
import { FilePage as File, FilesPage as Files } from "./files";
import { InboxEntryPage as Entry, InboxPage as Inbox } from "./inbox";
import { type ListScreen, legacySearch } from "./list-model";
import {
  SkillCandidatesPage as Candidates,
  SkillPage as Skill,
  SkillsPage as Skills,
} from "./skills";
import { SourcePage as Source, SourcesPage as Sources } from "./sources";

function useResourceId(): string {
  const { resourceId } = useParams({ strict: false }) as { resourceId?: string };
  return resourceId ?? "";
}

function rewrite(search: string, screen: ListScreen) {
  const next = legacySearch(search, screen);
  if (next !== null)
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${next}${window.location.hash}`,
    );
}

export function useLegacySearch(screen: ListScreen) {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  useState(() => {
    if (typeof window !== "undefined") rewrite(window.location.search, screen);
    return true;
  });
  useEffect(() => rewrite(search, screen), [search, screen]);
}

function Gated({
  testId,
  kind = "list",
  screen,
  permission,
  children,
}: {
  testId: string;
  kind?: "list" | "detail";
  screen: ListScreen;
  permission: string;
  children: ReactNode;
}) {
  const { permissions } = useSession();
  useLegacySearch(screen);
  return (
    <Screen testId={testId} kind={kind}>
      {permissions.includes(permission) ? children : <ForbiddenState />}
    </Screen>
  );
}

export const InboxPage = () => (
  <Gated testId="knowledge-inbox" screen="inbox" permission="intake:read">
    <Inbox />
  </Gated>
);
export function InboxEntryPage() {
  const id = useResourceId();
  return (
    <Gated testId="knowledge-inbox-entry" kind="detail" screen="inbox" permission="intake:read">
      <Entry key={id} id={id} />
    </Gated>
  );
}
export const SourcesPage = () => (
  <Gated testId="knowledge-sources" screen="sources" permission="knowledge:read">
    <Sources />
  </Gated>
);
export function SourcePage() {
  const id = useResourceId();
  return (
    <Gated testId="knowledge-source" kind="detail" screen="sources" permission="knowledge:read">
      <Source key={id} id={id} />
    </Gated>
  );
}
export const SkillsPage = () => (
  <Gated testId="knowledge-skills" screen="skills" permission="skill:read">
    <Skills />
  </Gated>
);
export const SkillCandidatesPage = () => (
  <Gated testId="knowledge-skill-candidates" screen="skills" permission="skill:read">
    <Candidates />
  </Gated>
);
export function SkillPage() {
  const id = useResourceId();
  if (id === "new")
    return (
      <Gated testId="knowledge-skills" screen="skills" permission="skill:read">
        <Skills creating />
      </Gated>
    );
  return (
    <Gated testId="knowledge-skill" kind="detail" screen="skills" permission="skill:read">
      <Skill key={id} id={id} />
    </Gated>
  );
}
export const FilesPage = () => (
  <Gated testId="knowledge-files" screen="files" permission="file:read">
    <Files />
  </Gated>
);
export function FilePage() {
  const id = useResourceId();
  return (
    <Gated testId="knowledge-file" kind="detail" screen="files" permission="file:read">
      <File key={id} id={id} />
    </Gated>
  );
}
