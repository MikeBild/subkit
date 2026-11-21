import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@ui/lib/ui-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import {
  type ClaimedFile,
  claimBody,
  claimedFiles,
  EMPTY_TRAY_MEMORY,
  mergeProblems,
  observeTray,
  type TrayItem,
  type TrayMemory,
  type TrayProblem,
  trayChips,
  trayUnavailable,
} from "../model/tray-model";

const TRAY_PATH = "/v1/chat/composer/attachments";

export const COMPOSER_TRAY_KEY = ["composer-tray"] as const;

async function listTray(): Promise<TrayItem[]> {
  try {
    return (await apiRequest<{ items: TrayItem[] }>(TRAY_PATH)).items;
  } catch (error) {
    if (trayUnavailable(error)) return [];
    throw error;
  }
}

async function removeTrayItem(id: string): Promise<void> {
  try {
    await apiRequest<null>(`${TRAY_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if ((error as { status?: unknown }).status !== 404) throw error;
  }
}

export async function claimComposerTray(
  conversationId: string,
  ids: readonly string[],
): Promise<ClaimedFile[]> {
  const body = claimBody(conversationId, ids);
  if (!body) return [];
  return claimedFiles(
    await apiRequest<Parameters<typeof claimedFiles>[0]>(`${TRAY_PATH}/claim`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

type PersonMemory = { memory: TrayMemory; removed: Set<string> };

const memories = new Map<string, PersonMemory>();

function memoryOf(person: string): PersonMemory {
  const known = memories.get(person);
  if (known) return known;
  const fresh = { memory: EMPTY_TRAY_MEMORY, removed: new Set<string>() };
  memories.set(person, fresh);
  return fresh;
}

export function useComposerTray(openKey: unknown) {
  const { permissions, principal } = useSession();
  const { t } = useI18n();
  const { now } = useUi();
  const queryClient = useQueryClient();
  const enabled = permissions.includes("conversation:write");
  const query = useQuery({
    queryKey: COMPOSER_TRAY_KEY,
    queryFn: listTray,
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const { refetch } = query;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [problems, setProblems] = useState<TrayProblem[]>([]);
  const person = memoryOf(principal.id);
  const items = query.data;
  useEffect(() => {
    if (!items) return;
    const observed = observeTray(person.memory, items, now(), person.removed);
    person.memory = observed.memory;
    if (observed.fresh.length > 0) setProblems((current) => mergeProblems(current, observed.fresh));
  }, [items, now, person]);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refetch]);
  const opened = useRef(openKey);
  useEffect(() => {
    if (opened.current === openKey || !enabled) return;
    opened.current = openKey;
    void refetch();
  }, [openKey, enabled, refetch]);
  const chips = useMemo(() => trayChips(items ?? [], now(), hidden), [items, hidden, now]);
  const remove = useCallback(
    async (ids: readonly string[]) => {
      for (const id of ids) person.removed.add(id);
      setHidden((current) => new Set([...current, ...ids]));
      try {
        await Promise.all(ids.map(removeTrayItem));
      } catch (error) {
        for (const id of ids) person.removed.delete(id);
        setHidden((current) => new Set([...current].filter((id) => !ids.includes(id))));
        reportFailure(t("chat.tray.removeFailed"), error);
      } finally {
        await queryClient.invalidateQueries({ queryKey: COMPOSER_TRAY_KEY });
      }
    },
    [queryClient, t, person],
  );
  const hold = useCallback(
    (ids: readonly string[]) => setHidden((current) => new Set([...current, ...ids])),
    [],
  );
  const release = useCallback(
    (ids: readonly string[]) =>
      setHidden((current) => new Set([...current].filter((id) => !ids.includes(id)))),
    [],
  );
  const dismiss = useCallback(() => setProblems([]), []);
  return { chips, problems, remove, hold, release, dismiss };
}

export type ComposerTray = ReturnType<typeof useComposerTray>;
