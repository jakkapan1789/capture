/**
 * The annotation model.
 *
 * Two rules hold this together:
 *
 * 1. Annotations are *data*, never pixels. They live beside the original PNG in a
 *    JSON file and are re-hydrated as editable objects when a capture is reopened.
 * 2. All coordinates are in **image pixel space** - the physical pixels of the
 *    captured PNG, not screen or CSS pixels. The stage is scaled to fit the
 *    viewport, so the same numbers stay correct at any zoom and export at full
 *    resolution without a conversion step.
 */

export type Tool =
  | "select"
  | "ocr"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "step"
  | "blur"
  | "crop"
  | "cut";

interface BaseAnnotation {
  id: string;
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArrowAnnotation extends BaseAnnotation {
  type: "arrow";
  /** Tail and head, relative to `x`/`y`, as `[x1, y1, x2, y2]`. */
  points: [number, number, number, number];
  stroke: string;
  strokeWidth: number;
}

export interface RectAnnotation extends BaseAnnotation {
  type: "rect";
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
}

/**
 * An outlined ellipse.
 *
 * Stored as a top-left box like [`RectAnnotation`], not as a centre and radii,
 * so dragging, the marquee and the transformer all treat it the same way as
 * every other box. `EllipseShape` converts to Konva's centre-based model when it
 * draws, and converts straight back.
 */
export interface EllipseAnnotation extends BaseAnnotation {
  type: "ellipse";
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
}

export interface TextAnnotation extends BaseAnnotation {
  type: "text";
  text: string;
  /**
   * Size in **logical** pixels, i.e. the number the user picked.
   *
   * Unlike every other measurement in this file, this is not in image pixels.
   * The editor multiplies by the capture's scale factor when rendering, so "16"
   * looks the same on a Retina capture as on a 1x one. A stored image-pixel size
   * would silently mean something different on every display.
   */
  fontSize: number;
  fill: string;
}

/**
 * A numbered badge. Note there is no `number` field: the displayed digit is derived
 * from the badge's position among the other step annotations, which is what makes
 * deleting or reordering renumber the rest for free.
 */
export interface StepAnnotation extends BaseAnnotation {
  type: "step";
  radius: number;
  fill: string;
}

export interface BlurAnnotation extends BaseAnnotation {
  type: "blur";
  width: number;
  height: number;
  mode: "blur" | "pixelate";
  /** Blur radius, or pixel block size when `mode` is `"pixelate"`. */
  strength: number;
}

/**
 * The visible bounds of the capture.
 *
 * Cropping is stored, never applied: the PNG on disk keeps every pixel, and this
 * rectangle just decides what the stage shows and what export rasterizes. That is
 * what lets a crop be widened again, or removed entirely, weeks later.
 *
 * At most one of these exists per capture; the editor enforces that.
 */
export interface CropAnnotation {
  type: "crop";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where an image object's pixels come from.
 *
 * `capture` is a piece of the screenshot itself, so it costs nothing to store -
 * it is just a rectangle into pixels we already have, and it survives a reload.
 *
 * `external` is a paste from the clipboard or another capture. Those pixels live
 * only in memory for the session and are flattened at export; see
 * `persistableAnnotations`.
 */
export type ImageSource =
  | {
      kind: "capture";
      /**
       * Which capture the pixels belong to.
       *
       * Without this a cut-out means "this rectangle of whatever is open",
       * so copying one into a different capture silently re-cut the new
       * picture at the same coordinates. Optional only for annotations saved
       * before it existed, where the owning capture is the right answer.
       */
      captureId?: string;
      crop: Rect;
    }
  | {
      /**
       * A flattened snapshot, stored as its own PNG beside the capture.
       *
       * Cut takes the picture *as it looks* - screenshot plus whatever
       * annotations were over it - which is what Paint does and what makes the
       * tool useful once a capture has been marked up. That cannot be expressed
       * as a rectangle into the original, so these pixels are the one thing in
       * the app that is genuinely flattened before export. Everything the piece
       * was cut from is still an editable object underneath it.
       */
      kind: "piece";
      captureId: string;
      pieceId: string;
      /**
       * Where the cut was taken from.
       *
       * A piece starts exactly over its source, so until it is dragged it is
       * showing the picture back to itself. Knowing the origin is what lets an
       * untouched cut be abandoned rather than left as a no-op pair of objects
       * that cancel each other out.
       */
      origin: { x: number; y: number };
      /**
       * The white rectangle left behind, so the pair can be abandoned together.
       *
       * Absent on a copy pasted elsewhere: that copy did not cut anything where
       * it landed, so there is no hole of its own to withdraw.
       */
      holeId?: string;
    }
  | { kind: "external" };

/**
 * A solid rectangle. Used as the white hole a Cut leaves behind.
 *
 * Still non-destructive: the screenshot underneath is untouched, this just paints
 * over it, so deleting the hole brings the original pixels back.
 */
export interface FillAnnotation extends BaseAnnotation {
  type: "fill";
  width: number;
  height: number;
  fill: string;
}

export interface ImageAnnotation extends BaseAnnotation {
  type: "image";
  width: number;
  height: number;
  source: ImageSource;
}

export type Annotation =
  | ArrowAnnotation
  | RectAnnotation
  | EllipseAnnotation
  | TextAnnotation
  | StepAnnotation
  | BlurAnnotation
  | FillAnnotation
  | ImageAnnotation
  | CropAnnotation;

export const ACCENT = "#ff3b30";

/**
 * Font for text annotations.
 *
 * Named once because it has to be identical in two places that measure text
 * independently: Konva draws the committed annotation on a canvas, and a real
 * `<textarea>` shows it while it is being typed. Konva's own default is Arial,
 * while the textarea was inheriting the UI font - so the words visibly changed
 * shape and width the moment you finished editing them.
 */
export const ANNOTATION_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Line height, again shared so a second line lands in the same place in both. */
export const ANNOTATION_LINE_HEIGHT = 1.25;

/** Default text size, in logical pixels. */
export const DEFAULT_FONT_SIZE = 16;

export const FONT_SIZES = [12, 14, 16, 20, 24, 32, 48, 64];

/** Which field carries an annotation's colour, or null if it has none. */
function colorField(annotation: Annotation): "stroke" | "fill" | null {
  switch (annotation.type) {
    case "arrow":
    case "rect":
    case "ellipse":
      return "stroke";
    case "text":
    case "step":
    case "fill":
      return "fill";
    default:
      return null;
  }
}

export function colorOf(annotation: Annotation): string | null {
  const field = colorField(annotation);
  return field ? ((annotation as unknown as Record<string, string>)[field] ?? null) : null;
}

export function colorPatch(annotation: Annotation, color: string): Partial<Annotation> | null {
  const field = colorField(annotation);
  return field ? ({ [field]: color } as Partial<Annotation>) : null;
}

export function createId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Badge numbers, keyed by annotation id.
 *
 * Derived from array order rather than stored, so removing the second of five
 * badges leaves 1-2-3-4 rather than a gap.
 */
export function stepNumbers(annotations: Annotation[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let next = 1;
  for (const annotation of annotations) {
    if (annotation.type === "step") numbers.set(annotation.id, next++);
  }
  return numbers;
}

/** True for objects whose pixels exist only in memory for this session. */
export function isSessionOnly(annotation: Annotation): boolean {
  return annotation.type === "image" && annotation.source.kind === "external";
}

/**
 * Ids of the cut-out pixel files these annotations still refer to.
 *
 * Sent with every save so the backend can delete the rest: undo, delete and
 * plain overwriting all orphan a piece file, and only the frontend knows which
 * ones are still live.
 */
export function livePieceIds(annotations: Annotation[]): string[] {
  return annotations.flatMap((annotation) =>
    annotation.type === "image" && annotation.source.kind === "piece"
      ? [annotation.source.pieceId]
      : [],
  );
}

/**
 * Annotations that are safe to write to disk.
 *
 * Pasted images are dropped: the JSON has no pixels to point at, so persisting
 * them would rehydrate as blank objects on the next open. Dropping them is the
 * agreed behaviour - paste, then export.
 */
export function persistableAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.filter((annotation) => !isSessionOnly(annotation));
}

/** True when a cut-out is still sitting exactly where it was cut from. */
export function isUnmovedPiece(annotation: Annotation): boolean {
  if (annotation.type !== "image" || annotation.source.kind !== "piece") return false;
  const { origin } = annotation.source;
  return annotation.x === origin.x && annotation.y === origin.y;
}

export function findCrop(annotations: Annotation[]): CropAnnotation | undefined {
  return annotations.find((annotation): annotation is CropAnnotation => annotation.type === "crop");
}

/** Crop is document state, not an object you can select or drag around. */
export function isSelectable(annotation: Annotation): boolean {
  return annotation.type !== "crop";
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}
