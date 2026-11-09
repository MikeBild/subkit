import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { absolute, recordHref } from "@/app/links";
import { useDirtyGuard } from "@/app/version-notice";
import {
  DataState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  MarkdownEditor,
  Page,
  PageHeader,
  SaveBar,
  SegmentedControl,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import {
  SKILL_APPLIES_TO,
  SKILL_TEMPLATES,
  type SkillAppliesTo,
  type SkillTemplate,
  skillAppliesToOptionKey,
  skillTemplateFromSearch,
  skillTemplateKeys,
} from "@/pages/skills-model";
import { useSkill } from "./skills-queries";

import { TEMPLATE_ICONS } from "./skills-template-icons";

export function SkillEditor({
  id,
  permissions,
  search,
}: {
  id: string;
  permissions: readonly string[];
  search: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const client = useQueryClient();
  const isNew = id === "new";
  const canWrite = permissions.includes("skill:write");
  const query = useSkill(id, permissions.includes("skill:read"));
  const skill = query.data;
  const template = isNew ? skillTemplateFromSearch(search) : null;
  const original = {
    title: skill?.title ?? "",
    body: skill?.body ?? "",
    appliesTo: (skill?.applies_to ?? "both") as SkillAppliesTo,
  };
  const [title, setTitle] = useState(() =>
    template ? t(skillTemplateKeys(template).title) : original.title,
  );
  const [body, setBody] = useState(() =>
    template ? t(skillTemplateKeys(template).body) : original.body,
  );
  const [appliesTo, setAppliesTo] = useState<SkillAppliesTo>(original.appliesTo);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (isNew) return;
    setTitle(skill?.title ?? "");
    setBody(skill?.body ?? "");
    setAppliesTo((skill?.applies_to ?? "both") as SkillAppliesTo);
  }, [isNew, skill?.title, skill?.body, skill?.applies_to]);
  const changes =
    (title !== original.title ? 1 : 0) +
    (body !== original.body ? 1 : 0) +
    (appliesTo !== original.appliesTo ? 1 : 0);
  const dirty = changes > 0;
  useDirtyGuard(dirty);

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? apiCall("post", "/v1/skills", {
            body: {
              scope: "global",
              title: title.trim(),
              body,
              applies_to: appliesTo,
              status: "active",
              source: "manual",
            },
          })
        : apiCall("patch", "/v1/skills/{id}", {
            path: { id },
            body: {
              title: title.trim(),
              body,
              applies_to: appliesTo,
              expected_version: skill?.version,
            },
          }),
    onSuccess: (saved) => {
      toast.success(t("skills.saved"));
      client.setQueryData(["skill", saved.id], saved);
      void client.invalidateQueries({ queryKey: ["catalog"] });
      router.history.push(absolute(recordHref("skills", saved.id)));
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t("skills.conflict")
          : t("detail.saveFailed"),
      ),
  });
  const submit = () => {
    setProblem(null);
    if (!title.trim()) return setProblem(t("skills.nameMissing"));
    if (!body.trim()) return setProblem(t("skills.bodyMissing"));
    save.mutate();
  };
  const applyTemplate = (next: SkillTemplate) => {
    const keys = skillTemplateKeys(next);
    if (!title.trim()) setTitle(t(keys.title));
    setBody(t(keys.body));
  };

  const back = isNew
    ? { to: "/skills", label: t("nav.skills") }
    : { to: recordHref("skills", id), label: skill?.title ?? t("nav.skills") };
  const header = (
    <PageHeader back={back} title={isNew ? t("skills.newTitle") : t("skills.editTitle")} />
  );
  if (!canWrite)
    return (
      <Page kind="detail" surface="detail" scroll="page" testId="skill-editor" header={header}>
        <ForbiddenState />
      </Page>
    );
  if (!isNew && query.isPending)
    return (
      <Page kind="detail" surface="detail" scroll="page" testId="skill-editor" header={header}>
        <DataState state="loading" />
      </Page>
    );

  return (
    <Page kind="detail" surface="detail" scroll="page" testId="skill-editor" header={header}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="skill-name">{t("common.name")}</FieldLabel>
          <Input
            id="skill-name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("skills.editor.namePlaceholder")}
            data-testid="skill-name"
          />
        </Field>
        <Field>
          <FieldLabel>{t("skills.editor.appliesTo")}</FieldLabel>
          <SegmentedControl
            label={t("skills.editor.appliesTo")}
            value={appliesTo}
            onValueChange={(next) => setAppliesTo(next as SkillAppliesTo)}
            options={SKILL_APPLIES_TO.map((value) => ({
              value,
              label: t(skillAppliesToOptionKey(value)),
              testId: `skill-applies-to-${value}`,
            }))}
            testId="skill-applies-to"
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="skill-body">{t("skills.editor.body")}</FieldLabel>
          {isNew ? (
            <div
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              data-testid="skill-templates"
            >
              {t("skills.editor.useTemplate")}
              {SKILL_TEMPLATES.map((entry) => {
                const Icon = TEMPLATE_ICONS[entry];
                return (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => applyTemplate(entry)}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`skill-template-${entry}`}
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                    {t(skillTemplateKeys(entry).title)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <MarkdownEditor
            id="skill-body"
            label={t("skills.editor.body")}
            value={body}
            onChange={setBody}
            placeholder={t("skills.editor.bodyPlaceholder")}
            rows={16}
            invalid={problem === t("skills.bodyMissing")}
            testId="skill-body"
          />
        </Field>
        {problem && !dirty ? (
          <FieldError className="sm:col-span-2" data-testid="skill-editor-error">
            {problem}
          </FieldError>
        ) : null}
      </div>
      {dirty ? (
        <SaveBar
          count={changes}
          notice={problem ?? undefined}
          discard={{
            onClick: () => {
              setTitle(original.title);
              setBody(original.body);
              setAppliesTo(original.appliesTo);
              setProblem(null);
            },
            testId: "skill-discard",
          }}
          save={{ onClick: submit, pending: save.isPending, testId: "skill-save" }}
          testId="skill-save-bar"
        />
      ) : null}
    </Page>
  );
}
