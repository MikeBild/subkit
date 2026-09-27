import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { CATALOG_RESOURCES } from "./route-table";

// The breadcrumb names two things: the list a record belongs to, and the
// record. The shell knows the first from the address; only the detail page
// knows the second, because a record's name arrives with the record. The page
// hands it up through this context, and until it does the crumb shows the list
// alone — never an id standing in for a name.

/** The lists whose records have an address of their own. */
const DETAIL_LISTS: readonly string[] = [...CATALOG_RESOURCES, "runs"];

/**
 * The list a detail address belongs to, router-relative — or nothing, for
 * every address that is not one record.
 *
 * A list page carries no breadcrumb: its title already says where the reader
 * is, and a crumb repeating it was the same word twice on one screen.
 */
export function recordListPath(pathname: string): string | null {
  const match = /^\/([^/]+)\/[^/]+$/.exec(pathname.replace(/^\/cockpit(?=\/)/, ""));
  const list = match?.[1];
  return list && DETAIL_LISTS.includes(list) ? `/${list}` : null;
}

const RecordCrumbContext = createContext<{
  label: string | null;
  setLabel(label: string | null): void;
}>({ label: null, setLabel: () => {} });

export function RecordCrumbProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  return (
    <RecordCrumbContext.Provider value={{ label, setLabel }}>
      {children}
    </RecordCrumbContext.Provider>
  );
}

/** A detail page names its record for the breadcrumb; `null` while it has none. */
export function useRecordCrumb(label: string | null): void {
  const { setLabel } = useContext(RecordCrumbContext);
  useEffect(() => {
    setLabel(label);
    return () => setLabel(null);
  }, [label, setLabel]);
}

export function useRecordCrumbLabel(): string | null {
  return useContext(RecordCrumbContext).label;
}
