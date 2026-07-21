import Konva from "konva";
import { useEffect, useRef } from "react";
import { Image as KonvaImage } from "react-konva";
import type { BlurAnnotation } from "../../lib/types";

/**
 * A non-destructive blur/pixelate region.
 *
 * This is not a grey box drawn over the screenshot - it is a second copy of the
 * screenshot, cropped to this rectangle, with a Konva filter on it. The original
 * pixels are never modified, so the region stays movable, resizable and removable
 * forever, and switching blur to pixelate is one property change.
 *
 * Because `crop` tracks `x`/`y`, dragging the region re-samples whatever is now
 * underneath it, which is the behaviour people expect from Snagit.
 */
interface Props {
  annotation: BlurAnnotation;
  image: HTMLImageElement;
  draggable: boolean;
  onChange: (patch: Partial<BlurAnnotation>) => void;
}

export default function BlurRegion({
  annotation,
  image,
  draggable,
  onChange,
}: Props) {
  const ref = useRef<Konva.Image>(null);
  const { x, y, width, height, mode, strength } = annotation;

  useEffect(() => {
    const node = ref.current;
    // Konva throws on caching a zero-area node, which happens mid-drag while the
    // user is still drawing the rectangle out.
    if (!node || width < 1 || height < 1) return;
    node.cache();
    node.getLayer()?.batchDraw();
  }, [x, y, width, height, mode, strength, image]);

  return (
    <KonvaImage
      ref={ref}
      id={annotation.id}
      image={image}
      x={x}
      y={y}
      width={width}
      height={height}
      // Sample the underlying screenshot at this rectangle's own position.
      crop={{ x, y, width, height }}
      filters={[mode === "blur" ? Konva.Filters.Blur : Konva.Filters.Pixelate]}
      blurRadius={strength}
      pixelSize={Math.max(2, Math.round(strength))}
      draggable={draggable}
      onDragEnd={(event) => onChange({ x: event.target.x(), y: event.target.y() })}
      onTransformEnd={(event) => {
        // Konva resizes via scale; fold it back into width/height so the crop and
        // the filter keep working in plain image pixels.
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
