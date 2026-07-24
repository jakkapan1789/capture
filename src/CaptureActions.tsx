import { useRef, useState } from "react";

import ContextMenu from "./components/ContextMenu";
import { CropIcon, GearIcon, MonitorIcon } from "./lib/icons";

/**
 * Capture and settings, at the right of the toolbar.
 *
 * The two capture actions share one button with a dropdown rather than a button
 * each. It is the same two commands, and folding them into one keeps the toolbar
 * narrow enough that the whole window can be - the pair cost the width that a
 * step badge selected over a crop needs, and something had to give.
 */
interface Props {
  onCaptureRegion: () => void;
  onCaptureScreen: () => void;
  onOpenSettings: () => void;
}

export default function CaptureActions({
  onCaptureRegion,
  onCaptureScreen,
  onOpenSettings,
}: Props) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setMenuAt({ x: rect.left, y: rect.bottom + 4 });
  };

  const run = (action: () => void) => {
    action();
    setMenuAt(null);
  };

  return (
    <div className="btn-group trailing">
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn accent capture-menu-btn"
        onClick={openMenu}
        title="Capture"
        aria-label="Capture"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
      >
        <CropIcon size={18} />
        <svg
          className="capture-menu-caret"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <GearIcon size={18} />
      </button>

      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)}>
          <button type="button" role="menuitem" onClick={() => run(onCaptureRegion)}>
            <CropIcon />
            <span>Capture region</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onCaptureScreen)}>
            <MonitorIcon />
            <span>Full screen</span>
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
