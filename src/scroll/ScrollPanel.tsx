import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { cancelScrollCapture, stopScrollCapture, SCROLL_PROGRESS } from "../lib/ipc";

interface Progress {
  height: number;
  problem: string | null;
}

/**
 * The panel shown while a scrolling capture is running.
 *
 * Its own small always-on-top window, placed clear of the region being captured
 * - every frame is a fresh grab of the screen, so a panel sitting over the
 * region would be captured along with it.
 *
 * It shows the height collected so far because that is the one thing you cannot
 * tell by looking: the capture is happening off-screen, and without a number
 * growing there is nothing to say it is working.
 */
export default function ScrollPanel() {
  const [progress, setProgress] = useState<Progress>({ height: 0, problem: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unlisten = listen<Progress>(SCROLL_PROGRESS, (event) => setProgress(event.payload));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void cancelScrollCapture();
      if (event.key === "Enter") void finish();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The window is closed by the backend once the capture is filed, so there
      // is nothing to do on the way out.
      await stopScrollCapture();
    } catch (error) {
      console.error("could not finish the scrolling capture", error);
      setBusy(false);
    }
  };

  return (
    <div className="scroll-panel">
      <div className="scroll-panel-text">
        <strong>{progress.problem ?? "Scroll the window you want to capture"}</strong>
        <span className={progress.problem ? "warn" : undefined}>
          {progress.height > 0 ? `${progress.height} px captured` : "Waiting for you to scroll..."}
        </span>
      </div>

      <div className="scroll-panel-actions">
        <button type="button" className="btn" onClick={() => void cancelScrollCapture()}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void finish()}>
          {busy ? "Joining..." : "Done"}
        </button>
      </div>
    </div>
  );
}
