import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

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
