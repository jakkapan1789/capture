import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

import { MonitorIcon } from "./lib/icons";

/**
 * Shown when macOS refuses screen capture.
 *
 * Without this the failure is invisible: macOS returns a screenshot of the
 * wallpaper with every window - and the desktop icons - silently missing, which
 * looks like a broken capture rather than a permission problem.
 */
const IS_MAC = navigator.userAgent.includes("Mac");

/** Deep link straight to the Screen Recording list in System Settings. */
const SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

interface Props {
  onClose: () => void;
}

export default function PermissionDialog({ onClose }: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Screen recording permission needed"
      >
        <header className="modal-header">
          <h2>Screen recording is off</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Close">
            &times;
          </button>
        </header>

        <div className="permission-body">
          <div className="permission-mark" aria-hidden="true">
            <MonitorIcon size={26} />
          </div>
          <div>
            <p>
              macOS is blocking screen capture, so screenshots come back as the desktop
              wallpaper with every window missing.
            </p>
            {IS_MAC && (
              <ol className="permission-steps">
                <li>Open Privacy &amp; Security → Screen &amp; System Audio Recording.</li>
                <li>
                  Turn on <strong>Capture</strong>.
                </li>
                <li>Quit and reopen Capture — macOS only applies this on restart.</li>
              </ol>
            )}
          </div>
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              // A ForbiddenUrl from an empty scope resolves as a rejected
              // promise with nothing on screen - which is how this button looked
              // broken. Log it so a future scope gap is visible, not silent.
              void openUrl(SETTINGS_URL).catch((error) =>
                console.error("could not open System Settings", error),
              );
            }}
          >
            Open System Settings
          </button>
        </footer>
      </div>
    </div>
  );
}
