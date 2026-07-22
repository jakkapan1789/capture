import { CropIcon, MonitorIcon } from "./lib/icons";

/**
 * The two ways to take a capture.
 *
 * They sit at the top of the history sidebar rather than in the editor toolbar.
 * That panel is already about captures - these make one, the list below browses
 * them - and the toolbar had run out of width for the tools that belong to the
 * picture you are actually editing.
 *
 * Labelled, unlike the tools: there is room here, and "which button takes a
 * region?" should not be a hover-and-wait question for the app's primary action.
 */
interface Props {
  onCaptureRegion: () => void;
  onCaptureScreen: () => void;
}

export default function CaptureActions({ onCaptureRegion, onCaptureScreen }: Props) {
  return (
    <div className="capture-actions">
      <button
        type="button"
        className="btn capture-btn primary"
        onClick={onCaptureRegion}
        title="Drag to select an area of the screen"
      >
        <CropIcon size={16} />
        <span>Capture region</span>
      </button>
      <button
        type="button"
        className="btn capture-btn"
        onClick={onCaptureScreen}
        title="Capture the whole screen"
      >
        <MonitorIcon size={16} />
        <span>Full screen</span>
      </button>
    </div>
  );
}
