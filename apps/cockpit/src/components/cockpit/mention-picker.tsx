import { BookOpen, Cable, CircleAlert, FileText, Layers, Sparkles, Workflow } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  PopoverContent,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  type ConversationReference,
  candidateToReference,
  findMentionQuery,
  findTokenAt,
  insertMention,
  insertMentionText,
  isInsideMentionToken,
  isReferenceCandidate,
  MENTION_TRIGGER,
  type MentionCandidate,
  type MentionCandidateType,
  type MentionQuery,
  splitByMentions,
} from "@/lib/mentions";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { cn } from "@/lib/utils";

const TYPE_ORDER: MentionCandidateType[] = [
  "category",
  "workflow",
  "connector",
  "knowledge_source",
  "skill",
  "file",
];

export const TYPE_ICON: Record<MentionCandidateType, typeof Workflow> = {
  category: Layers,
  workflow: Workflow,
  connector: Cable,
  knowledge_source: BookOpen,
  skill: Sparkles,
  file: FileText,
};

const GROUP_HEADING = {
  category: "chat.mention.categories",
  workflow: "chat.mention.workflows",
  connector: "chat.mention.connectors",
  knowledge_source: "chat.mention.sources",
  skill: "chat.mention.skills",
  file: "chat.mention.files",
} as const;

const candidateKey = (c: Pick<MentionCandidate, "type" | "id">) => `${c.type}:${c.id}`;

export interface MentionGroup {
  type: MentionCandidateType;
  items: MentionCandidate[];
}

export interface UseMentionInputOptions {
  value: string;
  setValue: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  references: ConversationReference[];
  setReferences: (next: ConversationReference[]) => void;
  candidates: readonly MentionCandidate[];
  onQueryChange: (query: string | null) => void;
  onPickFile?: (candidate: MentionCandidate) => void;
}

export function useMentionInput({
  value,
  setValue,
  textareaRef,
  references,
  setReferences,
  candidates,
  onQueryChange,
  onPickFile,
}: UseMentionInputOptions) {
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const mentionKey = useRef<string | null>(null);

  const groups = useMemo<MentionGroup[]>(() => {
    if (!mention) return [];
    return TYPE_ORDER.map((type) => ({
      type,
      items: candidates.filter((c) => c.type === type),
    })).filter((g) => g.items.length > 0);
  }, [mention, candidates]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (flat.length === 0) {
      setHighlighted(null);
      return;
    }
    if (!highlighted || !flat.some((c) => candidateKey(c) === highlighted)) {
      const first = flat[0];
      if (first) setHighlighted(candidateKey(first));
    }
  }, [flat, highlighted]);

  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value, textareaRef]);

  const close = useCallback(() => {
    mentionKey.current = null;
    setMention(null);
    onQueryChange(null);
  }, [onQueryChange]);

  const sync = useCallback(
    (text: string, caret: number | null) => {
      if (caret === null) {
        close();
        return;
      }
      if (references.length > 0 && isInsideMentionToken(text, references, caret)) {
        close();
        return;
      }
      const next = findMentionQuery(text, caret);
      const key = next ? `${next.start}:${next.query}` : null;
      if (key !== mentionKey.current) {
        mentionKey.current = key;
        setHighlighted(null);
      }
      setMention(next);
      onQueryChange(next ? next.query : null);
    },
    [close, references, onQueryChange],
  );

  const select = useCallback(
    (candidate: MentionCandidate) => {
      if (!mention) return;
      const caret = textareaRef.current?.selectionStart ?? value.length;
      if (candidate.type === "file") {
        pendingCaret.current = mention.start;
        setValue(value.slice(0, mention.start) + value.slice(caret));
        onPickFile?.(candidate);
        close();
        return;
      }
      if (!isReferenceCandidate(candidate)) {
        const result = insertMentionText(
          value,
          mention.start,
          caret,
          `${MENTION_TRIGGER}${candidate.label}`,
        );
        pendingCaret.current = result.caret;
        setValue(result.text);
        close();
        return;
      }
      const reference = candidateToReference(candidate);
      const result = insertMention(value, mention.start, caret, reference);
      pendingCaret.current = result.caret;
      setValue(result.text);
      const already = references.some((r) => r.type === reference.type && r.id === reference.id);
      if (!already) setReferences([...references, reference]);
      close();
    },
    [mention, textareaRef, value, setValue, references, setReferences, close, onPickFile],
  );

  const deleteToken = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (e.key !== "Backspace" && e.key !== "Delete") return false;
      if (references.length === 0) return false;
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return false;
      const caret = el.selectionStart;
      const hit = findTokenAt(value, references, e.key === "Backspace" ? caret - 1 : caret);
      if (!hit) return false;
      e.preventDefault();
      const nextText = value.slice(0, hit.start) + MENTION_TRIGGER + value.slice(hit.end);
      const nextCaret = hit.start + MENTION_TRIGGER.length;
      pendingCaret.current = nextCaret;
      setValue(nextText);
      sync(nextText, nextCaret);
      return true;
    },
    [references, value, setValue, sync],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (deleteToken(e)) return true;
      if (!mention) return false;
      const index = flat.findIndex((c) => candidateKey(c) === highlighted);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (flat.length === 0) return true;
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = flat[(index + step + flat.length) % flat.length];
        if (next) setHighlighted(candidateKey(next));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const item = flat[index] ?? flat[0];
        if (item) {
          e.preventDefault();
          select(item);
          return true;
        }
        return false;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [deleteToken, mention, flat, highlighted, select, close],
  );

  const onChange = useCallback(
    (text: string, caret: number | null) => {
      setValue(text);
      sync(text, caret);
    },
    [setValue, sync],
  );

  const onCaretMove = useCallback(
    (caret: number | null) => {
      sync(value, caret);
    },
    [sync, value],
  );

  return {
    open: mention !== null,
    query: mention?.query ?? null,
    groups,
    highlighted,
    setHighlighted,
    onKeyDown,
    onChange,
    onCaretMove,
    select,
    close,
  };
}

export interface MentionPickerProps {
  open: boolean;
  groups: MentionGroup[];
  highlighted: string | null;
  loading: boolean;
  onHighlight: (key: string) => void;
  onSelect: (candidate: MentionCandidate) => void;
}

export function MentionPicker({
  open,
  groups,
  highlighted,
  loading,
  onHighlight,
  onSelect,
}: MentionPickerProps) {
  const { t } = useI18n();
  if (!open) return null;
  let index = 0;
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      style={{ width: "var(--radix-popper-anchor-width)" }}
      className="overflow-hidden rounded-lg border p-0 ring-0"
      data-testid="chat-mention-popover"
    >
      <Command shouldFilter={false} value={highlighted ?? ""} onValueChange={onHighlight}>
        <CommandList className="max-h-64">
          {groups.length === 0 && (
            <CommandEmpty data-testid="chat-mention-empty">
              {t(loading ? "chat.mention.loading" : "chat.mention.empty")}
            </CommandEmpty>
          )}
          {groups.map((group) => {
            const Icon = TYPE_ICON[group.type];
            return (
              <CommandGroup key={group.type} heading={t(GROUP_HEADING[group.type])}>
                {group.items.map((item) => {
                  const testId = `chat-mention-item-${index++}`;
                  return (
                    <CommandItem
                      key={candidateKey(item)}
                      value={candidateKey(item)}
                      onSelect={() => onSelect(item)}
                      onMouseDown={(event) => event.preventDefault()}
                      data-testid={testId}
                    >
                      <Icon className="size-4 text-muted-foreground" />
                      {item.type === "category" ? (
                        <>
                          <span className="truncate font-medium">{item.label}</span>
                          <span className="truncate text-muted-foreground text-xs">
                            ·{" "}
                            {item.count === 1
                              ? t("chat.mention.categoryCountOne")
                              : t("chat.mention.categoryCount", { count: String(item.count ?? 0) })}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="truncate font-medium">{item.title}</span>
                          {item.type === "file" ? null : (
                            <span className="truncate text-muted-foreground text-xs">
                              {MENTION_TRIGGER}
                              {item.label}
                            </span>
                          )}
                        </>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            );
          })}
        </CommandList>
        <div className="border-t px-2 py-1 text-muted-foreground text-xs">
          {t("chat.mention.hint")}
        </div>
      </Command>
    </PopoverContent>
  );
}

export interface MentionChipsProps {
  text: string;
  references: readonly ConversationReference[];
  unresolved?: readonly ConversationReference[];
  hiddenLabel: string;
  testIdPrefix: string;
}

export function MentionChips({
  text,
  references,
  unresolved = [],
  hiddenLabel,
  testIdPrefix,
}: MentionChipsProps) {
  const { t } = useI18n();
  const gone = new Set(unresolved.map((r) => `${r.type}:${r.id}`));
  let index = 0;
  return (
    <span className="whitespace-pre-wrap" data-testid={`${testIdPrefix}-mentions`}>
      {splitByMentions(text, references).map((segment, i) => {
        if (!segment.reference) {
          return <span key={i}>{hideTechnicalIdentifiers(segment.text, hiddenLabel)}</span>;
        }
        const reference = segment.reference;
        const missing = gone.has(`${reference.type}:${reference.id}`);
        const Icon = missing ? CircleAlert : TYPE_ICON[reference.type];
        return (
          <span
            key={i}
            className={cn(
              "mx-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 align-baseline text-xs font-medium [&>svg]:size-3",
              missing
                ? "bg-destructive/10 text-destructive line-through"
                : "bg-secondary text-secondary-foreground",
            )}
            title={missing ? t("chat.mention.unresolved") : undefined}
            data-testid={`${testIdPrefix}-chip-${index++}`}
          >
            <Icon aria-hidden="true" />
            {segment.text}
          </span>
        );
      })}
    </span>
  );
}
