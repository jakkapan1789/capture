/**
 * The fullscreen region-selection overlay.
 *
 * Runs in its own transparent, borderless, always-on-top window. It reports the
 * drag in CSS pixels relative to this window; Rust adds the window's own origin to
 * get virtual-desktop coordinates, because only Rust knows where the window sits.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  captureRegion,
  closeRegionOverlay,
  startScrollCapture,
  type Region,
} from "../lib/ipc";

/**
 * Whether this overlay is picking a region for a scrolling capture.
 *
 * Set by the backend before the page loads. Read once, at module level, because
 * it cannot change for the life of the window.
 */
const FOR_SCROLLING =
  (window as unknown as { __CAPTURE_SCROLLING__?: boolean }).__CAPTURE_SCROLLING__ === true;

/** Whether the app scrolls for you, rather than watching you scroll. */
const AUTO_SCROLL =
  (window as unknown as { __CAPTURE_AUTO_SCROLL__?: boolean }).__CAPTURE_AUTO_SCROLL__ !== false;

/** Ignore stray clicks and accidental micro-drags. */
const MIN_DRAG = 4;

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

function toRegion(drag: DragState): Region {
  return {
    x: Math.min(drag.startX, drag.currentX),
    y: Math.min(drag.startY, drag.currentY),
    width: Math.abs(drag.currentX - drag.startX),
    height: Math.abs(drag.currentY - drag.startY),
  };
}

export default function RegionOverlay() {
  const [drag, setDrag] = useState<DragState | null>(null);
  // Guards against a second capture being fired while the first is in flight -
  // the window is still up during the pre-capture settle delay.
  const capturing = useRef(false);

  const cancel = useCallback(() => {
    void closeRegionOverlay();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (capturing.current) return;
    setDrag({
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    setDrag((previous) =>
      previous
        ? { ...previous, currentX: event.clientX, currentY: event.clientY }
        : previous,
    );
  };

  const onPointerUp = async () => {
    if (!drag || capturing.current) return;
    const region = toRegion(drag);
    setDrag(null);

    if (region.width < MIN_DRAG || region.height < MIN_DRAG) {
      cancel();
      return;
    }

    capturing.current = true;
    try {
      // The same drag, selecting for a different kind of capture. Which one is
      // decided by the URL the overlay was opened with, so this window does not
      // need to know how it was reached.
      if (FOR_SCROLLING) await startScrollCapture(region, AUTO_SCROLL);
      else await captureRegion(region);
    } catch (error) {
      console.error("region capture failed", error);
      cancel();
    }
  };

  const region = drag ? toRegion(drag) : null;

  return (
    <div
      className="overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => void onPointerUp()}
    >
      {/* Four panels around the selection rather than one dimmed layer with a
          hole punched in it - no compositing tricks, no seams. */}
      {region ? (
        <>
          <div className="scrim" style={{ inset: `0 0 auto 0`, height: region.y }} />
          <div
            className="scrim"
            style={{ top: region.y + region.height, bottom: 0, left: 0, right: 0 }}
          />
          <div
            className="scrim"
            style={{ top: region.y, height: region.height, left: 0, width: region.x }}
          />
          <div
            className="scrim"
            style={{
              top: region.y,
              height: region.height,
              left: region.x + region.width,
              right: 0,
            }}
          />
          <div
            className="selection"
            style={{
              left: region.x,
              top: region.y,
              width: region.width,
              height: region.height,
            }}
          />
          <div
            className="selection-size"
            style={{ left: region.x, top: Math.max(region.y - 26, 4) }}
          >
            {Math.round(region.width)} x {Math.round(region.height)}
          </div>
        </>
      ) : (
        <>
          <div className="scrim" style={{ inset: 0 }} />
          <div className="overlay-hint">Drag to select a region &middot; Esc to cancel</div>
        </>
      )}
    </div>
  );
}
