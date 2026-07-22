import { Image as KonvaImage } from "react-konva";
import type { ImageAnnotation } from "../../lib/types";

/**
 * A free-floating image object.
 *
 * Two flavours, one component:
 *
 * - `capture` — a rectangle cut out of a screenshot, identified by capture id.
 *   Costs nothing to store because it is only coordinates, and it survives a
 *   reload. Usually the open capture; when it points at another one, the parent
 *   loads that image and passes it as `sourceImage`.
 * - `piece` — a cut-out that was flattened at the moment of the cut, so it
 *   carries the annotations that were over it. Its pixels are a PNG stored
 *   beside the capture; the parent loads them and passes them as `pieceImage`.
 * - `external` — pasted from the clipboard or another capture. Its pixels live in
 *   memory for this session only.
 */
interface Props {
  annotation: ImageAnnotation;
  /** The open screenshot, used for cut-outs taken from this capture. */
  captureImage: HTMLImageElement;
  /** The *other* capture's image, when this piece was cut from a different one. */
  sourceImage?: HTMLImageElement;
  /** Flattened pixels for a `piece`, once read back from disk. */
  pieceImage?: CanvasImageSource;
  /** Resolved pixels for `external` pastes, if still in memory. */
  externalImage?: CanvasImageSource;
  draggable: boolean;
  onChange: (patch: Partial<ImageAnnotation>) => void;
}

export default function ImageObject({
  annotation,
  captureImage,
  sourceImage,
  pieceImage,
  externalImage,
  draggable,
  onChange,
}: Props) {
  const { x, y, width, height, source } = annotation;

  /**
   * Whether to draw this as lifted off the picture.
   *
   * A freshly cut piece sits exactly over the hole it left, so it is showing the
   * picture back to itself - and a drop shadow there reads as a smudge around a
   * rectangle rather than as depth. It gets its shadow once it has actually been
   * moved. Pasted images are always lifted, so they always get one.
   */
  const lifted =
    source.kind === "capture"
      ? x !== source.crop.x || y !== source.crop.y
      : source.kind === "piece"
        ? x !== source.origin.x || y !== source.origin.y
        : true;
  // A cut-out from another capture must draw that capture's pixels, not the
  // ones underneath it here.
  const image =
    source.kind === "capture"
      ? (sourceImage ?? captureImage)
      : source.kind === "piece"
        ? pieceImage
        : externalImage;

  // A pasted image whose session ended leaves nothing to draw. Render nothing
  // rather than letting Konva throw on an undefined source.
  if (!image) return null;

  return (
    <KonvaImage
      id={annotation.id}
      image={image}
      x={x}
      y={y}
      width={width}
      height={height}
      crop={source.kind === "capture" ? source.crop : undefined}
      draggable={draggable}
      shadowColor="#000000"
      shadowBlur={lifted ? 8 : 0}
      shadowOpacity={lifted ? 0.35 : 0}
      onDragEnd={(event) => onChange({ x: event.target.x(), y: event.target.y() })}
      onTransformEnd={(event) => {
        // Fold Konva's scale back into width/height so the crop rectangle and
        // any later transform keep working in plain image pixels.
        const node = event.target;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.scaleX(1);
        node.scaleY(1);
        onChange({
          x: node.x(),
          y: node.y(),
          width: Math.max(8, node.width() * scaleX),
          height: Math.max(8, node.height() * scaleY),
        });
      }}
    />
  );
}
