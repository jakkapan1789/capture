/**
 * Inline SVG icon set.
 *
 * Hand-rolled rather than pulled from an icon package: six tool glyphs cost about
 * 2 KB here, and "lightweight, minimal dependencies" is the whole reason this app
 * is Tauri and not Electron.
 *
 * Every icon shares one 24x24 grid, a 1.8 stroke and `currentColor`, so they take
 * their colour from the button they sit in and keep a consistent visual weight.
 */

import type { ReactNode } from "react";

interface SvgProps {
  size?: number;
  children: ReactNode;
}

function Svg({ size = 17, children }: SvgProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ---------- annotation tools ---------- */

export const SelectIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M5.5 2.8 L5.5 18.4 L9.7 14.5 L12.4 20.4 L15 19.2 L12.3 13.5 L18.2 13.1 Z" />
  </Svg>
);

export const ArrowIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M5.5 18.5 L18.5 5.5" />
    <path d="M11 5.5 H18.5 V13" />
  </Svg>
);

export const BoxIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
  </Svg>
);

export const TextIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M5 7 V4.5 H19 V7" />
    <path d="M12 4.5 V19.5" />
    <path d="M9 19.5 H15" />
  </Svg>
);

/** A numbered badge: circle plus a drawn "1" (no font dependency). */
export const StepIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10.7 9.6 L12.4 8.4 V15.6" />
    <path d="M10.5 15.6 H14.3" />
  </Svg>
);

/**
 * Dots dissolving toward the bottom right - reads as "softened".
 *
 * Deliberately only four dots: a denser grid turns to mush at 17px and starts to
 * look like a keyboard.
 */
export const BlurIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <g fill="currentColor" stroke="none">
      <circle cx="8.6" cy="8.6" r="2.1" />
      <circle cx="15.4" cy="8.6" r="1.6" opacity="0.6" />
      <circle cx="8.6" cy="15.4" r="1.6" opacity="0.6" />
      <circle cx="15.4" cy="15.4" r="1.15" opacity="0.32" />
    </g>
  </Svg>
);

/** Crop marks. Doubles as the app-bar region-capture icon. */
export const CropToolIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M6.5 2.5 V17.5 H21.5" />
    <path d="M2.5 6.5 H17.5 V21.5" />
  </Svg>
);

/** Scissors: lift a piece of the image out as its own object. */
export const CutIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <circle cx="6.5" cy="18" r="2.8" />
    <circle cx="17.5" cy="18" r="2.8" />
    <path d="M8.6 16 L19 3.5" />
    <path d="M15.4 16 L5 3.5" />
  </Svg>
);

/* ---------- actions ---------- */

export const MinusIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M5.5 12 H18.5" />
  </Svg>
);

export const PlusIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M12 5.5 V18.5" />
    <path d="M5.5 12 H18.5" />
  </Svg>
);

/** Shown when a region is in blur mode. */
export const DropletIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M12 3.5 C12 3.5 5.5 10.4 5.5 14.5 a6.5 6.5 0 0 0 13 0 C18.5 10.4 12 3.5 12 3.5 Z" />
  </Svg>
);

/** Shown when a region is in pixelate mode. */
export const MosaicIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
  </Svg>
);

/** Arrows to the corners: bring the whole image back into view. */
export const ExpandIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M9 3.5 H3.5 V9" />
    <path d="M15 3.5 H20.5 V9" />
    <path d="M15 20.5 H20.5 V15" />
    <path d="M9 20.5 H3.5 V15" />
  </Svg>
);

export const UndoIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M4 8.5 H14.5 a5.5 5.5 0 0 1 0 11 H8" />
    <path d="M8 4 L3.5 8.5 L8 13" />
  </Svg>
);

export const RedoIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M20 8.5 H9.5 a5.5 5.5 0 0 0 0 11 H16" />
    <path d="M16 4 L20.5 8.5 L16 13" />
  </Svg>
);

/** Folder, for revealing a file in the OS file manager. */
export const FolderIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M3 6.5 A1.5 1.5 0 0 1 4.5 5 H9.4 l2 2.6 H19.5 A1.5 1.5 0 0 1 21 9.1 V18 A1.5 1.5 0 0 1 19.5 19.5 H4.5 A1.5 1.5 0 0 1 3 18 Z" />
  </Svg>
);

export const TrashIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M4 6.5 H20" />
    <path d="M9.5 6.5 V4.5 H14.5 V6.5" />
    <path d="M6.5 6.5 L7.4 19.5 H16.6 L17.5 6.5" />
    <path d="M10.2 10 V16" />
    <path d="M13.8 10 V16" />
  </Svg>
);

export const CopyIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 5.5 V5 a1.5 1.5 0 0 0-1.5-1.5 H6 A2.5 2.5 0 0 0 3.5 6 v8 a1.5 1.5 0 0 0 1.5 1.5 h0.5" />
  </Svg>
);

/** Clipboard with an arrow in: paste. */
export const PasteIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M9 4.5 H7 A1.5 1.5 0 0 0 5.5 6 V19 A1.5 1.5 0 0 0 7 20.5 H17 A1.5 1.5 0 0 0 18.5 19 V6 A1.5 1.5 0 0 0 17 4.5 H15" />
    <rect x="9" y="2.5" width="6" height="4" rx="1.2" />
    <path d="M12 10.5 V16" />
    <path d="M9.6 13.6 L12 16 L14.4 13.6" />
  </Svg>
);

/** A picture frame: the flattened image, as opposed to selected objects. */
export const ImageIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.6" cy="9.6" r="1.5" />
    <path d="M3.6 16.8 L9 11.8 L14.4 16.9" />
    <path d="M13 15.5 L16 12.8 L20.4 16.6" />
  </Svg>
);

export const DownloadIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M12 3.5 V14.5" />
    <path d="M7.5 10.5 L12 15 L16.5 10.5" />
    <path d="M4.5 17 V19 a1.5 1.5 0 0 0 1.5 1.5 H18 a1.5 1.5 0 0 0 1.5-1.5 V17" />
  </Svg>
);

/* ---------- capture ---------- */

/** Crop marks, for region capture. */
export const CropIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <path d="M6.5 2.5 V17.5 H21.5" />
    <path d="M2.5 6.5 H17.5 V21.5" />
  </Svg>
);

export const GearIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.65l.06.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.91 1.37v.14a1.8 1.8 0 1 1-3.6 0v-.07a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.06a1.8 1.8 0 1 1-2.55-2.55l.06-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.91h-.14a1.8 1.8 0 1 1 0-3.6h.07a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.06-.05a1.8 1.8 0 1 1 2.55-2.55l.05.06a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .91-1.37v-.14a1.8 1.8 0 1 1 3.6 0v.07a1.5 1.5 0 0 0 .91 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.91h.14a1.8 1.8 0 1 1 0 3.6h-.07a1.5 1.5 0 0 0-1.37.91Z" />
  </Svg>
);

export const MonitorIcon = (props: { size?: number }) => (
  <Svg {...props}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
    <path d="M8.5 20.5 H15.5" />
    <path d="M12 17 V20.5" />
  </Svg>
);
