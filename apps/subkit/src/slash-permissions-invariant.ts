import type { UxGatingPermission } from "@shared/ux-gating.ts";

type _SlashRequiresMember<T> = T extends { requires: infer R }
  ? R extends UxGatingPermission
    ? T
    : never
  : T;

export type AssertSlashRequiresAreInUxGating<C extends readonly unknown[]> = {
  [K in keyof C]: _SlashRequiresMember<C[K]>;
};
