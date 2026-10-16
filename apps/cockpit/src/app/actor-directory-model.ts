import { appUserProvider } from "@/lib/app-user";

export type ActorKind = "user" | "system_account";
export type ActorKey = `${ActorKind}:${string}`;
export type ActorDirectory = ReadonlyMap<ActorKey, string>;
export type People = { items?: Array<{ id: string; email?: string; name?: string }> };
export type Accounts = { items?: Array<{ id: string; name?: string }> };

export function actorKey(kind: ActorKind, id: string): ActorKey {
  return `${kind}:${id}`;
}

export function actorDirectoryName(directory: ActorDirectory, kind: string, id: string | null) {
  if (!id || (kind !== "user" && kind !== "system_account")) return undefined;
  return directory.get(actorKey(kind, id));
}

export function actorDirectory(
  people: People | undefined,
  accounts: Accounts | undefined,
  appUserLabel: (provider: string) => string = (provider) => provider,
): ActorDirectory {
  const byActor = new Map<ActorKey, string>();
  for (const item of people?.items ?? []) {
    const email = item.email?.trim();
    const provider = appUserProvider(email);
    const label = provider === null ? email : appUserLabel(provider);
    if (label) byActor.set(actorKey("user", item.id), label);
  }
  for (const item of accounts?.items ?? []) {
    const label = item.name?.trim();
    if (label) byActor.set(actorKey("system_account", item.id), label);
  }
  return byActor;
}
