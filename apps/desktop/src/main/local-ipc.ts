import { FolderAccessSchema } from "@shared/device/boundary.ts";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import { CONNECT_CHANNELS } from "../shared/ipc.ts";
import type { LocalAllowances } from "./local-allowances.ts";

export type IpcHandle = <T>(
  channel: string,
  action: (...args: unknown[]) => T | Promise<T>,
) => void;

const PickOptionsSchema = z.object({ access: FolderAccessSchema, keepOut: z.boolean() }).strict();
const IdSchema = z.string().min(1).max(200);

export function registerLocalIpc(
  handle: IpcHandle,
  allowances: LocalAllowances,
  window: () => BrowserWindow | null,
): void {
  handle(CONNECT_CHANNELS.localListAllowances, () => allowances.view());
  handle(CONNECT_CHANNELS.localPickFolder, (options) =>
    allowances.pick(window(), PickOptionsSchema.parse(options)),
  );
  handle(CONNECT_CHANNELS.localRemoveAllowance, (id) => allowances.remove(IdSchema.parse(id)));
  handle(CONNECT_CHANNELS.localSetAccess, (id, access) =>
    allowances.setAccess(IdSchema.parse(id), FolderAccessSchema.parse(access)),
  );
  handle(CONNECT_CHANNELS.localSetPersonalEnabled, (enabled) =>
    allowances.setPersonalEnabled(z.boolean().parse(enabled)),
  );
  handle(CONNECT_CHANNELS.localAddSite, (origin) =>
    allowances.addSite(z.string().min(1).max(2048).parse(origin)),
  );
  handle(CONNECT_CHANNELS.localAddApp, () => allowances.pickApp(window()));
}
