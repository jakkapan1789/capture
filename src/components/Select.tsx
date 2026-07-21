import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A dropdown whose list is real DOM.
 *
 * A native `<select>` cannot be styled beyond its closed state: macOS draws the
 * open list as an NSMenu that ignores CSS almost entirely, so the popup would
 * stay light-on-white inside a dark app. Rebuilding it is the only way to make
 * the list match everything around it.
 *
 * The popup is positioned `fixed` from the trigger's measured rect rather than
 * absolutely inside it - the toolbar and dialogs both sit inside scrolling or
 * clipping ancestors that would cut an absolutely positioned list off.
 */
export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name; also used as the tooltip. */
  label: string;
  /** Extra class on the trigger, e.g. `size-select` for the numeric variant. */
  className?: string;
}

const ROW_HEIGHT = 32;
const POPUP_PADDING = 10;
const MAX_POPUP_HEIGHT = 288;
const MIN_POPUP_WIDTH = 132;
const VIEWPORT_MARGIN = 8;

export default function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** Ready-to-apply CSS for the fixed popup. */
  const [placement, setPlacement] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  }>({ left: 0, width: 0, top: 0 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex];

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const height = Math.min(options.length * ROW_HEIGHT + POPUP_PADDING, MAX_POPUP_HEIGHT);
    const spaceBelow = window.innerHeight - rect.bottom - 8;

    // Flip above only when there genuinely isn't room below and there is above.
    const above = height > spaceBelow && rect.top > spaceBelow;

    // The list is usually wider than its trigger, so a trigger near the right
    // edge would push the popup off screen. Keep it inside the viewport.
    const width = Math.max(rect.width, MIN_POPUP_WIDTH);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN),
    );

    setPlacement({
      left,
      width,
      ...(above
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setHighlight(selectedIndex);
  }, [open, place, selectedIndex]);

  // Reposition rather than drift if the window changes under an open list.
  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => place();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [open, highlight]);

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The editor listens for single-letter tool shortcuts on `window`; none of
    // them should fire while a list is open.
    event.stopPropagation();

    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        event.preventDefault();
        setHighlight((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((index) => Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setHighlight(0);
        break;
      case "End":
        event.preventDefault();
        setHighlight(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(highlight);
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className ? `select-trigger ${className}` : "select-trigger"}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onKeyDown}
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="select-value">{current?.label ?? ""}</span>
        <svg
          className="select-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </button>

      {open && (
        <>
          {/* Catches the click that dismisses the list, including one aimed back
              at the trigger - which would otherwise reopen it immediately. */}
          <div className="select-backdrop" onMouseDown={() => setOpen(false)} />
          <div
            ref={listRef}
            className="select-popup"
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={{
              left: placement.left,
              width: placement.width,
              top: placement.top,
              bottom: placement.bottom,
              maxHeight: MAX_POPUP_HEIGHT,
            }}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-highlighted={index === highlight}
                  className={index === highlight ? "select-option highlighted" : "select-option"}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => commit(index)}
                >
                  <span>{option.label}</span>
                  {isSelected && (
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
