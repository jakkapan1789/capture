import { Ellipse } from "react-konva";
import type { EllipseAnnotation } from "../../lib/types";

/**
 * An outlined ellipse, stored as a top-left box.
 *
 * Konva positions an ellipse by its centre and radii; the annotation model uses
 * a top-left box like every other shape, so drag, marquee selection and the
 * transformer all behave identically to the box tool. The conversion lives here
 * and nowhere else.
 */
interface Props {
  annotation: EllipseAnnotation;
  draggable: boolean;
  onChange: (patch: Partial<EllipseAnnotation>) => void;
}

export default function EllipseShape({ annotation, draggable, onChange }: Props) {
  const { x, y, width, height, stroke, strokeWidth } = annotation;
  const radiusX = width / 2;
  const radiusY = height / 2;

  return (
    <Ellipse
      id={annotation.id}
      x={x + radiusX}
      y={y + radiusY}
      radiusX={radiusX}
      radiusY={radiusY}
      stroke={stroke}
      strokeWidth={strokeWidth}
      // Widen the clickable area without widening the drawn line: an outline
      // with no fill is otherwise only grabbable exactly on the stroke.
      hitStrokeWidth={Math.max(strokeWidth * 3, 20)}
      shadowColor="#000000"
      shadowBlur={strokeWidth}
      shadowOpacity={0.3}
      draggable={draggable}
      onDragEnd={(event) =>
        onChange({
          x: event.target.x() - radiusX,
          y: event.target.y() - radiusY,
        })
      }
      onTransformEnd={(event) => {
        // Fold Konva's scale back into the radii, then convert the centre back
        // to a top-left box.
        const node = event.target;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.scaleX(1);
        node.scaleY(1);

        const nextWidth = Math.max(8, width * scaleX);
        const nextHeight = Math.max(8, height * scaleY);
        onChange({
          x: node.x() - nextWidth / 2,
          y: node.y() - nextHeight / 2,
          width: nextWidth,
          height: nextHeight,
        });
      }}
    />
  );
}
