import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

// The motion both tab bars share: one underline that slides to the chosen tab,
// and an edge fade where the bar scrolls sideways on a narrow screen.

/**
 * The underline's place under the active tab. Measured before paint, again
 * when the bar resizes (a count arriving widens a tab). Null until measured;
 * the bar then draws no underline rather than one in the wrong place.
 */
export function useTabIndicator(
  list: RefObject<HTMLElement | null>,
  activeSelector: string,
  active: string,
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const tab = element.querySelector<HTMLElement>(activeSelector);
      if (!tab) {
        setStyle(null);
        return;
      }
      setStyle({ width: tab.offsetWidth, transform: `translateX(${tab.offsetLeft}px)` });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [list, activeSelector, active]);
  return style;
}

/**
 * A sideways-scrolling bar fades out at the edge that has more behind it, so
 * a tab cut off at the screen's edge reads as "more", not as broken.
 */
export function useEdgeFade(scroller: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [edges, setEdges] = useState({ start: false, end: false });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scroller]);
  if (!edges.start && !edges.end) return undefined;
  const mask = `linear-gradient(to right, ${edges.start ? "transparent 0, #000 24px" : "#000 0"}, ${
    edges.end ? "#000 calc(100% - 24px), transparent 100%" : "#000 100%"
  })`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** The sliding underline's own class: one bar, moving on the motion tokens. */
export const TAB_INDICATOR =
  "pointer-events-none absolute bottom-0 left-0 h-0.5 bg-foreground transition-[transform,width] duration-(--sk-dur-base) ease-(--sk-ease-standard)";
