import { useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type PeopleSection, peopleSectionFromUrl } from "@/app/links";
import { useSession } from "@/app/session";
import { Button, Page, PageHeader, PageTabs } from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import {
  AppsTab,
  CreateRecordDialog,
  GrantAccessDialog,
  GrantsTab,
  GroupsTab,
  InvitePersonDialog,
  PeopleTab,
  RolesTab,
  SECTION_ACTION,
  SECTION_LABEL,
  usePeopleSectionViews,
} from "@/features/admin";
import { useI18n } from "@/lib/i18n-context";
import { openPeopleSection, readablePeopleSections } from "@/pages/admin-model";

export function PeopleAndAccessPage() {
  const { t } = useI18n();
  const session = useSession();
  const can = (permission: string) => session.permissions.includes(permission);
  const canIdentity = can("identity:read");
  const canRbac = can("rbac:read");
  const canSettings = can("settings:read");
  const readable = useMemo(
    () => readablePeopleSections({ identity: canIdentity, rbac: canRbac, settings: canSettings }),
    [canIdentity, canRbac, canSettings],
  );
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const section = openPeopleSection(peopleSectionFromUrl(searchStr), readable);
  const [creating, setCreating] = useState<PeopleSection | null>(null);
  const views = usePeopleSectionViews(
    { identity: canIdentity, rbac: canRbac, settings: canSettings },
    section,
    searchStr,
  );
  const actionFor = (value: PeopleSection) => {
    const spec = SECTION_ACTION[value];
    if (!spec || !can(spec.permission)) return null;
    return (
      <Button onClick={() => setCreating(value)} data-testid={spec.testId}>
        {t(spec.label)}
      </Button>
    );
  };
  const headerAction = section && views[section] === "ready" ? actionFor(section) : null;
  const content = (value: PeopleSection) => {
    const action = actionFor(value);
    if (value === "people") return <PeopleTab action={action} />;
    if (value === "roles") return <RolesTab action={action} />;
    if (value === "groups") return <GroupsTab action={action} />;
    if (value === "apps") return <AppsTab />;
    return <GrantsTab action={action} />;
  };
  return (
    <Page
      kind="list"
      scroll="page"
      testId="admin-people"
      header={<PageHeader title={t("resource.people.title")} action={headerAction} />}
    >
      {section === null ? (
        <ForbiddenState />
      ) : (
        <PageTabs
          param="section"
          testId="people-tabs"
          defaultValue={readable[0]}
          tabs={readable.map((value) => ({
            value,
            label: t(SECTION_LABEL[value]),
            testId: `people-tab-${value}`,
            content: content(value),
          }))}
        />
      )}
      <InvitePersonDialog
        open={creating === "people"}
        onOpenChange={(open) => !open && setCreating(null)}
      />
      <CreateRecordDialog
        kind={creating === "roles" ? "role" : creating === "groups" ? "group" : null}
        onOpenChange={(open) => !open && setCreating(null)}
      />
      <GrantAccessDialog
        open={creating === "grants"}
        onOpenChange={(open) => !open && setCreating(null)}
      />
    </Page>
  );
}
