import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

import { MonitorIcon } from "./lib/icons";

/**
 * Shown when macOS refuses a permission the app cannot work without.
 *
 * Both kinds fail invisibly, which is the reason this exists. Screen capture
 * comes back as the wallpaper with every window missing; a scroll event sent
 * without Accessibility is simply dropped, with no error to report. Either way
 * the app looks broken rather than blocked.
 */
const IS_MAC = navigator.userAgent.includes("Mac");

export type PermissionKind = "screen" | "input";

const COPY: Record<
  PermissionKind,
  { title: string; pane: string; url: string; explains: string; setting: string }
> = {
  screen: {
    title: "Screen recording is off",
    pane: "Screen & System Audio Recording",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    explains:
      "macOS is blocking screen capture, so screenshots come back as the desktop wallpaper with every window missing.",
    setting: "Screen & System Audio Recording",
  },
  input: {
    title: "Accessibility access is off",
    pane: "Accessibility",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    explains:
      "A scrolling capture scrolls the window for you, and macOS only lets an app do that with Accessibility access. Without it the scroll events are discarded silently and the capture never moves.",
    setting: "Accessibility",
  },
};

interface Props {
  kind?: PermissionKind;
  onClose: () => void;
}

export default function PermissionDialog({ kind = "screen", onClose }: Props) {
  const copy = COPY[kind];
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
        aria-label={copy.title}
      >
        <header className="modal-header">
          <h2>{copy.title}</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Close">
            &times;
          </button>
        </header>

        <div className="permission-body">
          <div className="permission-mark" aria-hidden="true">
            <MonitorIcon size={26} />
          </div>
          <div>
            <p>{copy.explains}</p>
            {IS_MAC && (
              <ol className="permission-steps">
                <li>Open Privacy &amp; Security → {copy.setting}.</li>
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
            onClick={() => void openUrl(copy.url)}
          >
            Open System Settings
          </button>
        </footer>
      </div>
    </div>
  );
}
