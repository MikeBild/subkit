export type Channel = "production" | "development";

export interface ChannelInfo {
  channel: Channel;
  name: string;
  appId: string;
  scheme: string;
  autostartFile: string;
}

export const CHANNELS: Record<Channel, ChannelInfo> = {
  production: {
    channel: "production",
    name: "SubKit",
    appId: "dev.mikebild.subkit.desktop",
    scheme: "subkit",
    autostartFile: "subkit-desktop.desktop",
  },
  development: {
    channel: "development",
    name: "SubKit Dev",
    appId: "dev.mikebild.subkit.desktop.dev",
    scheme: "subkit-dev",
    autostartFile: "subkit-desktop-dev.desktop",
  },
};

export function resolveChannel(built: unknown, packaged: boolean): ChannelInfo {
  return CHANNELS[built === "production" && packaged ? "production" : "development"];
}

export function loginCallback(scheme: string): string {
  return `${scheme}://callback`;
}

export interface ProtocolRegistration {
  scheme: string;
  executable: string | null;
  args: string[];
}

export function protocolRegistration(input: {
  scheme: string;
  defaultApp: boolean;
  execPath: string;
  argv: readonly string[];
}): ProtocolRegistration {
  const script = input.argv[1];
  return input.defaultApp && script
    ? { scheme: input.scheme, executable: input.execPath, args: [script] }
    : { scheme: input.scheme, executable: null, args: [] };
}
