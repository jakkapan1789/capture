import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import ContextMenu from "../components/ContextMenu";
import { CopyIcon, FolderIcon, ImageIcon, TrashIcon } from "../lib/icons";
import type { CaptureMeta } from "../lib/ipc";
import GalleryThumb from "./GalleryThumb";

/**
 * The history strip.
 *
 * Every capture is auto-saved, so this is the full history, and opening an entry
 * restores its annotations as editable objects rather than a flat picture.
 *
 * Only `PAGE_SIZE` rows are rendered at a time, and the thumbnails inside them
 * load lazily (see `GalleryThumb`), so a long history costs neither a wall of DOM
 * nor a burst of file reads on startup.
 */
const PAGE_SIZE = 60;
/** Rows within this many pixels of the scrollport start loading their image. */
const PRELOAD_MARGIN = 300;
/** Milliseconds between visibility recalculations while scrolling. */
const SCROLL_THROTTLE = 80;

interface Props {
  /** Capture buttons, above the list they add to. */
  captureActions: ReactNode;
  items: CaptureMeta[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onCleanUp: () => void;
  onCopyImage: (id: string) => void;
  onRevealInFolder: (id: string) => void;
}

function formatTime(millis: number): string {
  return new Date(millis).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function GalleryStrip({
  captureActions,
  items,
  activeId,
  onOpen,
  onDelete,
  onCleanUp,
  onCopyImage,
  onRevealInFolder,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);

  /**
   * Rows that have come near the viewport at least once.
   *
   * Sticky: a row that scrolls back out keeps its image rather than flickering
   * it away and re-reading the file the moment you scroll back.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState<Set<string>>(new Set());

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const top = scroller.scrollTop - PRELOAD_MARGIN;
    const bottom = scroller.scrollTop + scroller.clientHeight + PRELOAD_MARGIN;

    setArmed((current) => {
      let next: Set<string> | null = null;
      for (const row of scroller.querySelectorAll<HTMLElement>("[data-capture-id]")) {
        const id = row.dataset.captureId;
        if (!id || current.has(id)) continue;
        if (row.offsetTop + row.offsetHeight >= top && row.offsetTop <= bottom) {
          next ??= new Set(current);
          next.add(id);
        }
      }
      return next ?? current;
    });
  }, []);

  // One listener for the whole strip, throttled on a timer rather than on
  // `requestAnimationFrame`: a frame callback only runs when the page actually
  // paints, and this must keep working regardless.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        measure();
      }, SCROLL_THROTTLE);
    };

    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [measure]);

  // Newly rendered rows need measuring too, not just scrolling ones.
  useEffect(() => {
    measure();
  }, [measure, items, visible]);

  // Deleting a batch can strand the count above the list length; bring it back
  // so "Show more" reappears correctly if the history grows again.
  useEffect(() => {
    setVisible((current) => Math.max(PAGE_SIZE, Math.min(current, items.length)));
  }, [items.length]);

  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <aside className="gallery">
      {/* Outside the scrolling area, so it stays put however far you scroll. */}
      {captureActions}

      <div className="gallery-header">
        <h2 className="gallery-title">
          History
          {items.length > 0 && <span className="gallery-count">{items.length}</span>}
        </h2>
        {items.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            onClick={onCleanUp}
            title="Delete captures..."
            aria-label="Delete captures"
          >
            <TrashIcon size={15} />
          </button>
        )}
      </div>

      <div className="gallery-scroll" ref={scrollRef}>
        {items.length === 0 ? (
          <p className="gallery-empty">Captures you take will collect here.</p>
        ) : (
          <>
            <ul className="gallery-list">
              {shown.map((item) => (
                <li key={item.id} data-capture-id={item.id}>
                  <button
                    type="button"
                    className={item.id === activeId ? "gallery-item active" : "gallery-item"}
                    onClick={() => onOpen(item.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ x: event.clientX, y: event.clientY, id: item.id });
                    }}
                    title={item.id === activeId ? "Click again to close" : "Open this capture"}
                    aria-pressed={item.id === activeId}
                  >
                    <GalleryThumb id={item.id} load={armed.has(item.id)} />
                    <span className="gallery-meta">
                      <strong>{formatTime(item.createdAt)}</strong>
                      <span>
                        {item.width} x {item.height}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="gallery-delete"
                    title="Delete capture"
                    onClick={() => onDelete(item.id)}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>

            {remaining > 0 && (
              <button
                type="button"
                className="gallery-more"
                onClick={() => setVisible((current) => current + PAGE_SIZE)}
              >
                Show {Math.min(remaining, PAGE_SIZE)} more
                <span>{remaining} older</span>
              </button>
            )}
          </>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpen(menu.id);
              setMenu(null);
            }}
          >
            <ImageIcon />
            <span>{menu.id === activeId ? "Close" : "Open"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCopyImage(menu.id);
              setMenu(null);
            }}
          >
            <CopyIcon />
            <span>Copy image</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onRevealInFolder(menu.id);
              setMenu(null);
            }}
          >
            <FolderIcon />
            <span>Show in folder</span>
          </button>

          <div className="context-separator" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onDelete(menu.id);
              setMenu(null);
            }}
          >
            <TrashIcon />
            <span>Delete</span>
          </button>
        </ContextMenu>
      )}
    </aside>
  );
}

/**
 * Memoised: the strip re-renders only when the list or the highlight changes,
 * not on every keystroke and drag in the editor next to it.
 */
export default memo(GalleryStrip);
