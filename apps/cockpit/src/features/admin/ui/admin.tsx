import { useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type PeopleSection, peopleSectionFromUrl } from "@/app/links";
import { useSession } from "@/app/session";
import { Button, PageTabs } from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { AppsTab } from "../apps-tab";
import { GrantAccessDialog, GrantsTab } from "../grants-tab";
import { GroupsTab } from "../groups-tab";
import { openPeopleSection, readablePeopleSections } from "../model/admin-model";
import { SECTION_ACTION, SECTION_LABEL, usePeopleSectionViews } from "../people-sections";
import { InvitePersonDialog, PeopleTab } from "../people-tab";
import { CreateRecordDialog, RolesTab } from "../roles-tab";

export function PeopleArea() {
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
  const headerAction =
    section && section !== "people" && views[section] === "ready" ? actionFor(section) : null;
  const content = (value: PeopleSection) => {
    const action = actionFor(value);
    if (value === "people") return <PeopleTab action={action} />;
    if (value === "roles") return <RolesTab action={action} />;
    if (value === "groups") return <GroupsTab action={action} />;
    if (value === "apps") return <AppsTab />;
    return <GrantsTab action={action} />;
  };
  return (
    <div className="flex flex-col gap-4" data-testid="admin-people">
      {headerAction ? <div className="flex justify-end">{headerAction}</div> : null}
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
    </div>
  );
}
