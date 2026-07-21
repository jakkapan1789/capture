import type { ComponentType, ReactNode } from "react";

import Select from "../components/Select";

import {
  ArrowIcon,
  BlurIcon,
  BoxIcon,
  CropToolIcon,
  CutIcon,
  DropletIcon,
  ExpandIcon,
  MinusIcon,
  MosaicIcon,
  PlusIcon,
  RedoIcon,
  SelectIcon,
  StepIcon,
  TextIcon,
  TrashIcon,
  UndoIcon,
} from "../lib/icons";
import { FONT_SIZES, PALETTE, type Annotation, type Tool } from "../lib/types";

const TOOLS: {
  tool: Tool;
  label: string;
  hint: string;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { tool: "select", label: "Select", hint: "V", Icon: SelectIcon },
  { tool: "arrow", label: "Arrow", hint: "A", Icon: ArrowIcon },
  { tool: "rect", label: "Box", hint: "R", Icon: BoxIcon },
  { tool: "text", label: "Text", hint: "T", Icon: TextIcon },
  { tool: "step", label: "Step", hint: "S", Icon: StepIcon },
  { tool: "blur", label: "Blur", hint: "B", Icon: BlurIcon },
  { tool: "crop", label: "Crop", hint: "C", Icon: CropToolIcon },
  { tool: "cut", label: "Cut", hint: "X", Icon: CutIcon },
];

interface Props {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  /** The selected annotation when exactly one is selected, else null. */
  selected: Annotation | null;
  selectionCount: number;
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
  onDelete: () => void;
  onResetCrop: () => void;
  onReorderStep: (delta: -1 | 1) => void;
  onToggleBlurMode: () => void;
  status: string | null;
  /** Pinned to the far right, after the status text. */
  actions: ReactNode;
}

export default function Toolbar({
  tool,
  onToolChange,
  selected,
  selectionCount,
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
  onDelete,
  onResetCrop,
  onReorderStep,
  onToggleBlurMode,
  status,
  actions,
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
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? "seg-btn active" : "seg-btn"}
              onClick={() => onToolChange(value)}
              title={`${label} (${hint})`}
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
          {PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={swatch === color ? "swatch active" : "swatch"}
              style={{ background: swatch }}
              onClick={() => onColorChange(swatch)}
              title={swatch}
              aria-label={`Colour ${swatch}`}
            />
          ))}
          {/* Native picker for anything not on the palette. */}
          <label className="swatch custom" title="Custom colour">
            <input
              type="color"
              value={color}
              onChange={(event) => onColorChange(event.target.value)}
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

      {selectionCount > 0 && (
        <div className="btn-group">
          {/* Icon-only, so the count that used to be in the label lives in the
              tooltip and the accessible name instead of being lost. */}
          <button
            type="button"
            className="btn danger icon-only"
            onClick={onDelete}
            title={
              selectionCount > 1
                ? `Delete ${selectionCount} objects (Del)`
                : "Delete (Del)"
            }
            aria-label={
              selectionCount > 1 ? `Delete ${selectionCount} objects` : "Delete"
            }
          >
            <TrashIcon />
          </button>
        </div>
      )}

      <div className="toolbar-spacer" />

      {status && <span className="status">{status}</span>}

      {actions}
    </div>
  );
}
