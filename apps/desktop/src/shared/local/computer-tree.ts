import { createHash } from "node:crypto";
import {
  type AxNode,
  isSecureNode,
  type Rect,
  SECURE_PLACEHOLDER,
} from "@shared/local-policy/redaction-rects.ts";
import { z } from "zod";

export const RectSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export interface RawNode {
  role: string;
  name?: string | undefined;
  value?: string | null | undefined;
  description?: string | undefined;
  ref_id?: string | null | undefined;
  native_id?: { kind: string; value: string } | undefined;
  states?: string[] | undefined;
  bounds?: Rect | undefined;
  children_count?: number | undefined;
  subtree_truncated?: boolean | undefined;
  children?: RawNode[] | undefined;
}

export const RawNodeSchema: z.ZodType<RawNode> = z.lazy(() =>
  z.looseObject({
    role: z.string(),
    name: z.string().optional(),
    value: z.string().nullable().optional(),
    description: z.string().optional(),
    ref_id: z.string().nullable().optional(),
    native_id: z.looseObject({ kind: z.string(), value: z.string() }).optional(),
    states: z.array(z.string()).optional(),
    bounds: RectSchema.optional(),
    children_count: z.number().optional(),
    subtree_truncated: z.boolean().optional(),
    children: z.array(RawNodeSchema).optional(),
  }),
);

function hasState(node: RawNode, state: string): boolean {
  return node.states?.includes(state) === true;
}

export function toAxNode(node: RawNode): AxNode {
  return {
    role: node.role,
    label: node.name ?? null,
    value: node.value ?? null,
    ref: node.ref_id ?? null,
    secure: hasState(node, "secure"),
    focused: hasState(node, "focused"),
    frame: node.bounds ?? null,
    children: (node.children ?? []).map(toAxNode),
  };
}

export interface ModelNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly ref?: string;
  readonly states?: readonly string[];
  readonly children?: readonly ModelNode[];
}

export function modelTree(node: RawNode): ModelNode {
  if (isSecureNode(toAxNode(node))) return { role: "password", name: SECURE_PLACEHOLDER };
  const states = node.states ?? [];
  const children = (node.children ?? []).map(modelTree);
  return {
    role: node.role,
    ...(node.name ? { name: node.name } : {}),
    ...(node.value ? { value: node.value } : {}),
    ...(node.ref_id ? { ref: node.ref_id } : {}),
    ...(states.length > 0 ? { states } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

type Canonical = [string, string, string, string[], Canonical[]];

function canonical(node: RawNode): Canonical {
  return [
    node.role,
    node.name ?? "",
    node.description ?? "",
    (node.states ?? []).filter((state) => state !== "focused").sort(),
    (node.children ?? []).map(canonical),
  ];
}

export function focusPath(node: RawNode): number[] | null {
  if (hasState(node, "focused")) return [];
  const children = node.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const below = focusPath(children[index] as RawNode);
    if (below !== null) return [index, ...below];
  }
  return null;
}

export function stateHash(tree: RawNode): string {
  return createHash("sha256")
    .update(JSON.stringify({ tree: canonical(tree), focus: focusPath(tree) }))
    .digest("hex");
}

export interface RefInfo {
  readonly role: string;
  readonly label: string;
  readonly secure: boolean;
  readonly path: readonly number[];
}

export function findRef(tree: RawNode, ref: string): RefInfo | null {
  if (tree.ref_id === ref) {
    return {
      role: tree.role,
      label: tree.name ?? "",
      secure: isSecureNode(toAxNode(tree)),
      path: [],
    };
  }
  const children = tree.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const found = findRef(children[index] as RawNode, ref);
    if (found !== null) return { ...found, path: [index, ...found.path] };
  }
  return null;
}

export function nodeAt(tree: RawNode, path: readonly number[]): RawNode | null {
  let node: RawNode | undefined = tree;
  for (const index of path) node = node?.children?.[index];
  return node ?? null;
}

export function labelHash(deviceId: string, bundleId: string, role: string, label: string): string {
  return createHash("sha256")
    .update(`${deviceId}\u0000${bundleId}\u0000${role}\u0000${label}`)
    .digest("hex");
}

export function fullyObserved(node: RawNode): boolean {
  if (node.subtree_truncated === true) return false;
  const { children = [], children_count = children.length } = node;
  if (children_count > children.length) return false;
  return children.every(fullyObserved);
}
