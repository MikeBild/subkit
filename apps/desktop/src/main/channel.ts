import { app } from "electron";
import { type ChannelInfo, resolveChannel } from "../shared/channel.ts";

declare const SUBKIT_DESKTOP_CHANNEL: string;

export const CHANNEL: ChannelInfo = resolveChannel(SUBKIT_DESKTOP_CHANNEL, app.isPackaged);
