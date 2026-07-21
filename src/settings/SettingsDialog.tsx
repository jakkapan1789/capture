import { useCallback, useEffect, useState } from "react";

import { buildAccelerator, formatAccelerator, isModifierCode, MAX_KEYS } from "../lib/hotkey";
import { getSettings, setCaptureHotkey, type SettingsView } from "../lib/ipc";

interface Props {
  onClose: () => void;
  onShowAbout: () => void;
}

export default function SettingsDialog({ onClose, onShowAbout }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [recording, setRecording] = useState(false);
  /** Modifiers shown live while the user is still holding keys down. */
  const [held, setHeld] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * Problem with the combination currently held, shown while you hold it.
   *
   * Waiting until release to say "too many keys" would mean discovering the
   * limit only after failing - the one case you cannot fix by pressing more.
   */
  const [liveIssue, setLiveIssue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getSettings()
      .then(setSettings)
      .catch((cause) => setError(`Could not load settings: ${cause}`));
  }, []);

  const commit = useCallback(async (accelerator: string | null) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await setCaptureHotkey(accelerator));
    } catch (cause) {
      // The backend re-registers the previous hotkey on failure, so the old one
      // is still live - say so rather than leaving the user guessing.
      setError(String(cause));
    } finally {
      setSaving(false);
      setRecording(false);
      setHeld("");
    }
  }, []);

  /**
   * Key capture, committed on release rather than on the first non-modifier key.
   *
   * Committing on keydown locks in whatever is held at that instant, which breaks
   * the common case of reaching for a three-key combination and not pressing the
   * modifiers first: pressing A before Shift would save "Cmd+A" and stop
   * listening. Holding builds the combination up; letting go saves it.
   *
   * Runs in the capture phase so the editor's single-letter tool shortcuts never
   * see these keystrokes.
   */
  useEffect(() => {
    if (!recording) return;

    // The main (non-modifier) key currently held, and the best complete
    // combination seen while the keys were down.
    let mainCode: string | null = null;
    let candidate: string | null = null;
    let issue: string | null = null;

    const reset = () => {
      mainCode = null;
      candidate = null;
      issue = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Ignore auto-repeat while a key is held down.
      if (event.repeat) return;

      if (event.key === "Escape") {
        setRecording(false);
        setHeld("");
        setLiveIssue(null);
        reset();
        return;
      }

      if (!isModifierCode(event.code)) mainCode = event.code;

      const result = buildAccelerator(event, mainCode);
      setHeld(result.preview);

      if (result.kind === "accelerator") {
        candidate = result.accelerator;
        issue = null;
        setLiveIssue(null);
      } else if (result.kind === "invalid") {
        candidate = null;
        issue = result.message;
        // Only complain live once a real key is down; "add a modifier" while
        // they are still reaching for one would just be noise.
        setLiveIssue(mainCode ? result.message : null);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (candidate) {
        setLiveIssue(null);
        void commit(candidate);
        reset();
        return;
      }

      // Releasing a lone modifier is not a mistake - keep listening.
      if (!mainCode) return;

      // Letting a key go can bring an over-long combination back within the
      // limit. The keyup event's modifier flags describe what is *still* held,
      // so rebuilding from it is exactly the right thing to save.
      const retry = buildAccelerator(event, mainCode);
      if (retry.kind === "accelerator") {
        setLiveIssue(null);
        void commit(retry.accelerator);
        reset();
        return;
      }

      if (issue) {
        setError(issue);
        setHeld("");
        setLiveIssue(null);
        reset();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording, commit]);

  // Escape closes the dialog, but only when not mid-recording.
  useEffect(() => {
    if (recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording, onClose]);

  const hotkey = settings?.captureRegionHotkey ?? null;

  const chipLabel = recording
    ? held || "Listening..."
    : hotkey
      ? formatAccelerator(hotkey)
      : "Disabled";

  // Clicking the backdrop deliberately does nothing: recording a shortcut means
  // holding modifiers down, and a stray click outside dismissing the dialog
  // mid-gesture would lose the combination being set. Escape and the close
  // button are the only ways out.
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Close">
            &times;
          </button>
        </header>

        <section className="setting">
          <div className="setting-text">
            <strong>Capture region</strong>
            <span>Works even when Capture is in the background.</span>
          </div>

          <button
            type="button"
            className={recording ? "hotkey-chip recording" : "hotkey-chip"}
            onClick={() => {
              setError(null);
              setLiveIssue(null);
              setRecording(true);
              setHeld("");
            }}
            disabled={saving}
            title={
              hotkey
                ? `${formatAccelerator(hotkey)} - click, then hold the new combination and let go`
                : "Click, then hold the combination you want and let go"
            }
            aria-label="Change the capture region shortcut"
          >
            {chipLabel}
          </button>
        </section>

        {/* One fixed-height slot for every message this dialog can show. They
            are mutually exclusive in practice, and reserving the space stops the
            dialog from growing and shrinking under the pointer as you click. */}
        <div className="setting-message">
          {error ? (
            <p className="setting-error">{error}</p>
          ) : recording && liveIssue ? (
            <p className="setting-hint warn">{liveIssue}</p>
          ) : recording ? (
            <p className="setting-hint">{`Hold up to ${MAX_KEYS} keys, then let go.`}</p>
          ) : settings && hotkey && !settings.hotkeyRegistered ? (
            // Saved but refused by the OS - usually another app owns it.
            <p className="setting-warning">
              This shortcut is not active. Another application is probably using it.
            </p>
          ) : (
            <p className="setting-hint">Click the shortcut to change it.</p>
          )}
        </div>

        <footer className="modal-footer">
          {/* Left-aligned: About is not an action on these settings. */}
          <button type="button" className="link-btn footer-link" onClick={onShowAbout}>
            About Capture
          </button>
          <div className="modal-footer-spacer" />
          <button
            type="button"
            className="btn"
            disabled={saving || !settings || hotkey === settings.defaultHotkey}
            onClick={() => settings && void commit(settings.defaultHotkey)}
          >
            Reset to default
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving || !hotkey}
            onClick={() => void commit(null)}
          >
            Disable
          </button>
        </footer>
      </div>
    </div>
  );
}
