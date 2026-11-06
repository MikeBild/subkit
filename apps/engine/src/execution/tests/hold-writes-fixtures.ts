export function holdWritesFixtures() {
  const hits: Array<{ method: string; url: string }> = [];

  function hitsFor(path: string): Array<{ method: string; url: string }> {
    return hits.filter((h) => h.url.startsWith(path));
  }

  return { hits, hitsFor };
}
