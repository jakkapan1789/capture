import { useCallback, useEffect, useState } from "react";

import { buildAccelerator, formatAccelerator, isModifierCode, MAX_KEYS } from "../lib/hotkey";
import {
  getSettings,
  setCaptureHotkey,
  updatePreferences,
  type PreferencesPatch,
  type SettingsView,
} from "../lib/ipc";
import Toggle from "../components/Toggle";

interface Props {
  onClose: () => void;
  onShowAbout: () => void;
  /**
   * Announces every saved change, so the rest of the app can act on a preference
   * without polling for it. Auto-copy is read on the capture path.
   */
  onSettingsChange?: (settings: SettingsView) => void;
}

export default function SettingsDialog({ onClose, onShowAbout, onSettingsChange }: Props) {
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

  /**
   * Record a settings view, in the one place every read and write funnels
   * through.
   *
   * Reporting on *load* as well as on save matters: the app keeps its own copy
   * to decide things like auto-copy, and if the two ever disagree the app acts
   * on a value the user cannot see. Opening this dialog now reconciles them.
   */
  const applyView = useCallback(
    (view: SettingsView) => {
      setSettings(view);
      onSettingsChange?.(view);
    },
    [onSettingsChange],
  );

  useEffect(() => {
    void getSettings()
      .then(applyView)
      .catch((cause) => setError(`Could not load settings: ${cause}`));
  }, [applyView]);

  const setPreference = useCallback(
    async (patch: PreferencesPatch) => {
      setSaving(true);
      setError(null);
      try {
        applyView(await updatePreferences(patch));
      } catch (cause) {
        setError(String(cause));
      } finally {
        setSaving(false);
      }
    },
    [applyView],
  );

  const commit = useCallback(async (accelerator: string | null) => {
    setSaving(true);
    setError(null);
    try {
      applyView(await setCaptureHotkey(accelerator));
    } catch (cause) {
      // The backend re-registers the previous hotkey on failure, so the old one
      // is still live - say so rather than leaving the user guessing.
      setError(String(cause));
    } finally {
      setSaving(false);
      setRecording(false);
      setHeld("");
    }
  }, [applyView]);

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

        <section className="setting-group">
          <h3 className="setting-group-title">Shortcut</h3>

          <div className="setting">
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
          </div>

          {/* One fixed-height slot for every message this dialog can show. They
              are mutually exclusive in practice, and reserving the space stops
              the dialog from growing and shrinking under the pointer. */}
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

          {/* Beside the shortcut they act on. In the footer they read as
              applying to the whole page, which is wrong now there is more than
              one preference on it. */}
          <div className="setting-actions">
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
          </div>
        </section>

        <section className="setting-group">
          <h3 className="setting-group-title">Capture</h3>

          <div className="setting">
            <div className="setting-text">
              <strong>Copy to clipboard automatically</strong>
              <span>Every new capture is copied the moment it is taken.</span>
            </div>

            <Toggle
              label="Copy every new capture to the clipboard"
              checked={settings?.autoCopyToClipboard ?? false}
              disabled={saving || !settings}
              onChange={(checked) => void setPreference({ autoCopyToClipboard: checked })}
            />
          </div>
        </section>

        <footer className="modal-footer">
          {/* Left-aligned: About is not an action on these settings. */}
          <button type="button" className="link-btn footer-link" onClick={onShowAbout}>
            About Capture
          </button>
          <div className="modal-footer-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </footer>

      </div>
    </div>
  );
}
