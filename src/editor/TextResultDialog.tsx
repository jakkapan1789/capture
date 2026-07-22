import { useEffect, useRef, useState } from "react";

import { CopyIcon } from "../lib/icons";

/**
 * The text OCR found, shown before it goes anywhere.
 *
 * Recognition is good but not perfect - a stray character, a misread heading -
 * so handing the result straight to the clipboard means the mistake is only
 * discovered after pasting it somewhere. Showing it first makes the result
 * something to check and correct rather than something to trust.
 *
 * The text is editable for that reason: Copy sends whatever is in the box, not
 * whatever the engine said.
 */
interface Props {
  lines: string[];
  onCopy: (text: string) => Promise<void>;
  onClose: () => void;
}

export default function TextResultDialog({ lines, onCopy, onClose }: Props) {
  const [text, setText] = useState(() => lines.join("\n"));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Focused and selected on open, so the whole result can be taken with Cmd+C
  // without touching the mouse - the button is for everything else.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copy = async () => {
    setError(null);
    try {
      await onCopy(text);
      setCopied(true);
      // Long enough to read, short enough that it is gone before the next copy.
      setTimeout(() => setCopied(false), 1600);
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Recognised text">
        <header className="modal-header">
          <h2>Text found</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Close">
            &times;
          </button>
        </header>

        <textarea
          ref={areaRef}
          className="text-result"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          aria-label="Recognised text, editable before copying"
        />

        {/* Fixed-height slot, so the dialog does not resize when the confirmation
            appears under the pointer. */}
        <div className="setting-message">
          {error ? (
            <p className="setting-error">{error}</p>
          ) : (
            <p className="setting-hint">
              {copied
                ? "Copied to clipboard"
                : `${lines.length} ${lines.length === 1 ? "line" : "lines"} — edit before copying if anything is wrong`}
            </p>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
          <div className="modal-footer-spacer" />
          <button type="button" className="btn primary" onClick={() => void copy()}>
            <CopyIcon size={15} />
            Copy
          </button>
        </footer>
      </div>
    </div>
  );
}
