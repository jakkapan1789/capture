import { CropIcon, GearIcon, MonitorIcon } from "./lib/icons";

/**
 * Capture and settings buttons.
 *
 * These used to sit in their own bar above everything. They live in the toolbar
 * now, which removes a whole row of chrome - the app name belongs in the window
 * title bar, not repeated inside the window.
 *
 * Rendered in the editor toolbar when a capture is open, and in a slim bar of
 * its own when nothing is, so capturing is always one click away.
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
  return (
    <div className="btn-group trailing">
      <button
        type="button"
        className="icon-btn accent"
        onClick={onCaptureRegion}
        title="Capture region - drag to select an area"
        aria-label="Capture region"
      >
        <CropIcon size={18} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onCaptureScreen}
        title="Capture the whole screen"
        aria-label="Capture screen"
      >
        <MonitorIcon size={18} />
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
    </div>
  );
}
