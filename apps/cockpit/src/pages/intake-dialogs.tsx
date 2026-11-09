import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type CreateIntakeClipInput, createIntakeClip, type IntakeClip } from "@/api/intake";
import {
  categoryChoices,
  normalizeCategoryInput,
} from "@/components/cockpit/catalog-metadata-model";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  FormDialog,
  MarkdownEditor,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import { intakeNoteRequest } from "./intake-model";

import { invalidateIntake } from "./intake-queries";

const NEW_CATEGORY = "__new__";
export function IntakeEditDialog({
  clip,
  categories,
  open,
  pending,
  error,
  conflict,
  onReload,
  onOpenChange,
  onSave,
}: {
  clip: IntakeClip | null;
  categories: string[];
  open: boolean;
  pending: boolean;
  error: string | null;
  conflict: boolean;
  onReload(): void;
  onOpenChange(open: boolean): void;
  onSave(
    clip: IntakeClip,
    input: {
      expected_version: number;
      category?: string;
      title?: string;
      body?: string;
      note?: string;
    },
  ): void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(clip?.title ?? "");
  const [body, setBody] = useState(clip?.body ?? "");
  const [choice, setChoice] = useState(clip?.category ?? "");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(clip?.title ?? "");
    setBody(clip?.body ?? "");
    setChoice(clip?.category ?? "");
    setFresh("");
  }, [clip, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const trimmedTitle = title.trim();
  const choices = categoryChoices(categories, clip?.category ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  const changed =
    clip !== null &&
    (trimmedTitle !== clip.title || body !== clip.body || category !== clip.category);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.editItem")}
      size="wide"
      submit={{
        label: t("common.save"),
        pending,
        disabled: !clip || !trimmedTitle || !body || !category || !changed,
        testId: "intake-edit-save",
      }}
      onSubmit={() => {
        if (!clip || !trimmedTitle || !body || !category || !changed) return;
        onSave(clip, {
          expected_version: clip.version,
          ...(trimmedTitle !== clip.title ? { title: trimmedTitle } : {}),
          ...(body !== clip.body ? { body } : {}),
          ...(category !== clip.category ? { category } : {}),
        });
      }}
      error={error}
      actions={
        conflict ? (
          <Button
            type="button"
            variant="outline"
            onClick={onReload}
            data-testid="intake-edit-reload"
          >
            {t("settings.reload")}
          </Button>
        ) : undefined
      }
      testId="intake-edit-dialog"
    >
      <TextField
        id="intake-edit-title"
        label={t("resource.field.title")}
        value={title}
        onChange={setTitle}
        error={title && !trimmedTitle ? t("intake.editTitleRequired") : null}
      />
      <Field>
        <FieldLabel htmlFor="intake-edit-body">{t("knowledge.content")}</FieldLabel>
        <MarkdownEditor
          id="intake-edit-body"
          label={t("knowledge.content")}
          value={body}
          onChange={setBody}
          rows={10}
          invalid={!body}
          testId="intake-edit-body"
        />
        {!body ? <FieldError>{t("intake.editBodyRequired")}</FieldError> : null}
      </Field>
      <p className="text-xs text-muted-foreground">{t("intake.editKeepsKnowledge")}</p>
      <SelectField
        id="intake-edit-category"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-edit-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}

export function IntakeNoteDialog({
  categories,
  initialCategory,
  open,
  onOpenChange,
  onCreated,
}: {
  categories: string[];
  initialCategory: string | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(clip: IntakeClip): void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [choice, setChoice] = useState(initialCategory ?? "");
  const [fresh, setFresh] = useState("");
  const attempt = useRef<{ content: string; id: string; at: Date } | null>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setChoice(initialCategory ?? "");
    setFresh("");
    setTouched(false);
    attempt.current = null;
  }, [initialCategory, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const choices = categoryChoices(categories, initialCategory ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  const create = useMutation({
    mutationFn: (input: CreateIntakeClipInput) => createIntakeClip(input),
    onSuccess: async (clip) => {
      await invalidateIntake(queryClient);
      onCreated(clip);
    },
  });
  const invalidCategory = choice === NEW_CATEGORY && !freshCategory;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.add.title")}
      size="wide"
      submit={{
        label: t("intake.add.submit"),
        pending: create.isPending,
        disabled: invalidCategory,
        testId: "intake-add-submit",
      }}
      onSubmit={() => {
        setTouched(true);
        if (invalidCategory) return;
        const content = JSON.stringify([title, body, category]);
        if (attempt.current?.content !== content)
          attempt.current = { content, id: crypto.randomUUID(), at: new Date() };
        const request = intakeNoteRequest({
          clientRequestId: attempt.current.id,
          title,
          body,
          category,
          capturedAt: attempt.current.at,
        });
        if (request) create.mutate(request);
      }}
      error={create.error ? t("intake.add.failed") : null}
      testId="intake-add-dialog"
    >
      <TextField
        id="intake-add-title"
        label={t("resource.field.title")}
        value={title}
        onChange={setTitle}
        error={touched && !title.trim() ? t("intake.editTitleRequired") : null}
      />
      <Field>
        <FieldLabel htmlFor="intake-add-body">{t("knowledge.content")}</FieldLabel>
        <MarkdownEditor
          id="intake-add-body"
          label={t("knowledge.content")}
          value={body}
          onChange={setBody}
          rows={10}
          invalid={touched && !body.trim()}
          testId="intake-add-body"
        />
        {touched && !body.trim() ? <FieldError>{t("intake.editBodyRequired")}</FieldError> : null}
      </Field>
      <SelectField
        id="intake-add-category"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-add-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">{t("intake.add.hint")}</p>
    </FormDialog>
  );
}

export function IntakeDefaultCategoryDialog({
  category,
  initialCategory,
  categories,
  open,
  onOpenChange,
  onSave,
}: {
  category: string | undefined;
  initialCategory: string | undefined;
  categories: string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(category: string): void;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState(initialCategory ?? category ?? "");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setChoice(initialCategory ?? category ?? "");
    setFresh("");
  }, [category, initialCategory, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const selected = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const choices = categoryChoices(categories, category ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.makeDefault")}
      submit={{
        label: t("common.save"),
        disabled: !selected || selected === category,
        testId: "intake-default-category-save",
      }}
      onSubmit={() => {
        if (selected && selected !== category) onSave(selected);
      }}
      testId="intake-default-category-dialog"
    >
      <SelectField
        id="intake-default-category-input"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-default-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}
