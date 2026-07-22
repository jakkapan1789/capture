import type { ComponentType } from "react";

import Select from "../components/Select";

import {
  ArrowIcon,
  BlurIcon,
  BoxIcon,
  CircleIcon,
  CropToolIcon,
  CutIcon,
  GearIcon,
  DropletIcon,
  ExpandIcon,
  MinusIcon,
  OcrIcon,
  MosaicIcon,
  PlusIcon,
  RedoIcon,
  SelectIcon,
  StepIcon,
  TextIcon,
  UndoIcon,
} from "../lib/icons";
import { FONT_SIZES, type Annotation, type Tool } from "../lib/types";

const TOOLS: {
  tool: Tool;
  label: string;
  hint: string;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { tool: "select", label: "Select", hint: "V", Icon: SelectIcon },
  { tool: "arrow", label: "Arrow", hint: "A", Icon: ArrowIcon },
  { tool: "rect", label: "Box", hint: "R", Icon: BoxIcon },
  { tool: "ellipse", label: "Ellipse", hint: "O", Icon: CircleIcon },
  { tool: "text", label: "Text", hint: "T", Icon: TextIcon },
  { tool: "step", label: "Step", hint: "S", Icon: StepIcon },
  { tool: "blur", label: "Blur", hint: "B", Icon: BlurIcon },
  { tool: "crop", label: "Crop", hint: "C", Icon: CropToolIcon },
  { tool: "cut", label: "Cut", hint: "X", Icon: CutIcon },
  { tool: "ocr", label: "Copy text", hint: "G", Icon: OcrIcon },
];

interface Props {
  /** Tools this platform cannot run, shown but not selectable. */
  disabledTools?: Tool[];
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  /** The selected annotation when exactly one is selected, else null. */
  selected: Annotation | null;
  hasCrop: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  showColor: boolean;
  color: string;
  onColorChange: (color: string) => void;
  showFontSize: boolean;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  onResetCrop: () => void;
  onReorderStep: (delta: -1 | 1) => void;
  onToggleBlurMode: () => void;
  status: string | null;
  onOpenSettings: () => void;
}

export default function Toolbar({
  tool,
  disabledTools,
  onToolChange,
  selected,
  hasCrop,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  showColor,
  color,
  onColorChange,
  showFontSize,
  fontSize,
  onFontSizeChange,
  onResetCrop,
  onReorderStep,
  onToggleBlurMode,
  status,
  onOpenSettings,
}: Props) {
  return (
    <div className="toolbar">
      <div className="btn-group leading">
        <button
          type="button"
          className="btn icon-only"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd/Ctrl+Z)"
          aria-label="Undo"
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="btn icon-only"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd/Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          <RedoIcon />
        </button>
      </div>

      {/* Tools are a segmented control: one choice is always active, which is
          exactly what a mode switch should look like. */}
      <div className="segmented" role="radiogroup" aria-label="Annotation tool">
        {TOOLS.map(({ tool: value, label, hint, Icon }) => {
          const active = value === tool;
          const disabled = disabledTools?.includes(value) ?? false;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? "seg-btn active" : "seg-btn"}
              disabled={disabled}
              onClick={() => onToolChange(value)}
              title={
                disabled
                  ? `${label} is not available on this platform yet`
                  : `${label} (${hint})`
              }
              aria-label={label}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>

      {/* Contextual controls, shown only for what is actually selected. */}
      {hasCrop && (
        <div className="btn-group">
          <button
            type="button"
            className="btn icon-only"
            onClick={onResetCrop}
            title="Reset crop - show the whole image"
            aria-label="Reset crop"
          >
            <ExpandIcon />
          </button>
        </div>
      )}

      {showColor && (
        <div className="btn-group">
          {/* Two controls, not a row of presets: what the colour is now, and a
              way to change it. The OS picker already offers a palette, recent
              colours and an eyedropper, so duplicating a handful of swatches in
              the toolbar only spent space. */}
          <span
            className="color-current"
            style={{ background: color }}
            title={`Current colour ${color}`}
            aria-hidden="true"
          />
          <label className="color-pick" title="Choose a colour">
            <input
              type="color"
              value={color}
              onChange={(event) => onColorChange(event.target.value)}
              aria-label="Choose a colour"
            />
          </label>
        </div>
      )}

      {showFontSize && (
        <div className="btn-group">
          <span className="btn-group-label">Size</span>
          <Select
            className="size-select"
            value={fontSize}
            options={FONT_SIZES.map((size) => ({ value: size, label: String(size) }))}
            onChange={onFontSizeChange}
            label="Text size"
          />
        </div>
      )}

      {selected?.type === "step" && (
        <div className="btn-group">
          <button
            type="button"
            className="btn icon-only"
            onClick={() => onReorderStep(-1)}
            title="Give this badge a lower number"
          >
            <MinusIcon />
          </button>
          <span className="btn-group-label">Number</span>
          <button
            type="button"
            className="btn icon-only"
            onClick={() => onReorderStep(1)}
            title="Give this badge a higher number"
          >
            <PlusIcon />
          </button>
        </div>
      )}

      {selected?.type === "blur" && (
        <div className="btn-group">
          <button
            type="button"
            className="btn"
            onClick={onToggleBlurMode}
            title="Switch between blur and pixelate"
          >
            {selected.mode === "blur" ? <DropletIcon /> : <MosaicIcon />}
            <span>{selected.mode === "blur" ? "Blur" : "Pixelate"}</span>
          </button>
        </div>
      )}

      <div className="toolbar-spacer" />

      {status && <span className="status">{status}</span>}

      <div className="btn-group trailing">
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
    </div>
  );
}
