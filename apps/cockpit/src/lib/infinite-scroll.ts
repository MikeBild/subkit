export interface ScrollBox {
  scrollHeight: number;
  clientHeight: number;
  parentElement: ScrollBox | null;
}

const SCROLLING = new Set(["auto", "scroll", "overlay"]);

export const PREFETCH_MARGIN = "0px 0px 320px 0px";

export function scrollRoot<T extends ScrollBox>(start: T, overflowY: (box: T) => string): T | null {
  let box = start.parentElement as T | null;
  while (box) {
    if (SCROLLING.has(overflowY(box)) && box.scrollHeight > box.clientHeight) return box;
    box = box.parentElement as T | null;
  }
  return null;
}

export interface PagingState {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

export function wantsNextPage(
  entries: readonly { isIntersecting: boolean }[],
  paging: PagingState,
): boolean {
  return (
    paging.hasNextPage &&
    !paging.isFetchingNextPage &&
    entries.some((entry) => entry.isIntersecting)
  );
}
