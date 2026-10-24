export async function resolveLiveSuccessor<T>(
  authority_id: string,
  resolve: (id: string) => Promise<string>,
  live: (id: string) => Promise<T | undefined>,
): Promise<T | undefined> {
  const resolved = await resolve(authority_id);
  const row = await live(resolved);
  if (row) return row;
  const successor = await resolve(resolved);
  if (successor === resolved) return undefined;
  return live(successor);
}
