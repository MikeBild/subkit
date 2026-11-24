import { browserTimeZone } from "@/lib/timezones";

export const scheduleZone = ({
  scheduleZone,
  workspaceZone,
}: {
  scheduleZone?: string | null;
  workspaceZone?: string | null;
}): string => scheduleZone ?? workspaceZone ?? browserTimeZone();
