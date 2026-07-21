import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A right-click menu anchored at a point.
 *
 * Position is corrected after the first paint from the menu's measured size,
 * rather than from a guess at how tall its rows are - the caller adds and removes
 * items depending on what was clicked, so any hard-coded estimate drifts.
 */
interface Props {
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}

const MARGIN = 8;

export default function ContextMenu({ x, y, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Render at the raw point first; the layout effect corrects it before paint.
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    });
  }, [x, y, children]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <>
      {/* A full-viewport backdrop is the simplest way to close on "click
          anywhere else", including a click back on whatever opened the menu. */}
      <div
        className="context-backdrop"
        onMouseDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div ref={ref} className="context-menu" style={position} role="menu">
        {children}
      </div>
    </>
  );
}
