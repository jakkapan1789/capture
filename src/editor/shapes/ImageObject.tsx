import { Image as KonvaImage } from "react-konva";
import type { ImageAnnotation } from "../../lib/types";

/**
 * A free-floating image object.
 *
 * Two flavours, one component:
 *
 * - `capture` — a rectangle cut out of the screenshot itself. Costs nothing to
 *   store because it only references pixels we already have, and it survives a
 *   reload. The original stays untouched underneath; this is a copy you can move.
 * - `external` — pasted from the clipboard or another capture. Its pixels live in
 *   memory for this session only.
 */
interface Props {
  annotation: ImageAnnotation;
  /** The screenshot, used as the pixel source for `capture` cut-outs. */
  captureImage: HTMLImageElement;
  /** Resolved pixels for `external` pastes, if still in memory. */
  externalImage?: CanvasImageSource;
  draggable: boolean;
  onChange: (patch: Partial<ImageAnnotation>) => void;
}

export default function ImageObject({
  annotation,
  captureImage,
  externalImage,
  draggable,
  onChange,
}: Props) {
  const { x, y, width, height, source } = annotation;
  const image = source.kind === "capture" ? captureImage : externalImage;

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
      shadowBlur={8}
      shadowOpacity={0.35}
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
