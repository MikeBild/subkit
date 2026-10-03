// `@`-mentions in the chat composer.
//
// `useMentionInput` owns everything a mention-capable textarea does — trigger
// detection, ranked groups, keyboard navigation, whole-token deletion and
// caret restore. `MentionPicker` is the popover (cmdk `Command`, so the list
// and its selection state are the same primitive every other palette in the
// Cockpit uses). `MentionChips` renders a sent message's tokens as chips.
//
// The entity icons are the navigation's own (`Workflow`, `Cable`), so a
// workflow reads as the same thing in the rail, the picker and the transcript.

import { Cable, CircleAlert, FileText, Layers, Library, Sparkles, Workflow } from "lucide-react";
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

// Categories first: a block of the catalog is the broadest thing to point at.
// Then the automation objects, then what SubKit knows: sources, skills, files.
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
  knowledge_source: Library,
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
  /** The in-progress query (null when the picker is closed) — the owner
   *  fetches candidates for it. */
  onQueryChange: (query: string | null) => void;
  /** A stored file was picked: it joins the message as an attachment. */
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
  // Which query the highlight belongs to, so a caret move does not reset
  // the row the person just walked to with the arrow keys.
  const mentionKey = useRef<string | null>(null);

  const groups = useMemo<MentionGroup[]>(() => {
    if (!mention) return [];
    return TYPE_ORDER.map((type) => ({
      type,
      items: candidates.filter((c) => c.type === type),
    })).filter((g) => g.items.length > 0);
  }, [mention, candidates]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Keep the highlight on a row that still exists as the list shrinks.
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

  // Caret positions apply after React commits the new value; otherwise the
  // re-render parks the caret at the end of the text.
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
      // A caret parked inside a completed token is a click, not a query.
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
      // A file is not a word in the text: the typed `@query` goes, and the
      // file stands above the field as an attachment.
      if (candidate.type === "file") {
        pendingCaret.current = mention.start;
        setValue(value.slice(0, mention.start) + value.slice(caret));
        onPickFile?.(candidate);
        close();
        return;
      }
      // A category is a phrase, not a reference: it goes into the text as
      // `@kategorie/<name>` and nothing travels beside it.
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

  // A mention is one unit: a single Backspace or Delete removes the whole
  // token and leaves the trigger, so the picker reopens for a different pick.
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

  /** Returns true when the event was consumed (deletion or picker navigation). */
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
  // Portalled above the composer. Drawn inside the composer area it was cut
  // off by that area's own scroll box: the menu was in the DOM, correct, and
  // invisible — typing "@" seemed to do nothing.
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      // The caret stays in the textarea; the menu never takes focus.
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
                      // Keep the caret in the textarea: a click here must not blur it.
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
  /** Replacement for a raw identifier in the plain runs (never shown as-is). */
  hiddenLabel: string;
  testIdPrefix: string;
}

/** A sent message's text with its `@`-tokens rendered as chips. */
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
          // Masking runs only over the plain runs: a chip label is display
          // text the person picked, never an identifier.
          return <span key={i}>{hideTechnicalIdentifiers(segment.text, hiddenLabel)}</span>;
        }
        const reference = segment.reference;
        const missing = gone.has(`${reference.type}:${reference.id}`);
        const Icon = missing ? CircleAlert : TYPE_ICON[reference.type];
        return (
          // A chip is a reference, not a state: no dot, no badge.
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
