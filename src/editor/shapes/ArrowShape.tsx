import { Arrow, Circle, Group } from "react-konva";
import type { ArrowAnnotation } from "../../lib/types";

/**
 * An arrow with draggable endpoints.
 *
 * A Konva Transformer would scale the arrowhead along with the shaft, which looks
 * wrong, so when selected the arrow grows two handles instead and the tail/head
 * are edited directly.
 */
interface Props {
  annotation: ArrowAnnotation;
  selected: boolean;
  draggable: boolean;
  /** Handle size, in image pixels, kept constant on screen as the view scales. */
  handleRadius: number;
  onChange: (patch: Partial<ArrowAnnotation>) => void;
}

export default function ArrowShape({
  annotation,
  selected,
  draggable,
  handleRadius,
  onChange,
}: Props) {
  const { x, y, points, stroke, strokeWidth } = annotation;
  const [x1, y1, x2, y2] = points;

  const moveEndpoint = (index: 0 | 1, nextX: number, nextY: number) => {
    const next: [number, number, number, number] = [...points];
    next[index * 2] = nextX;
    next[index * 2 + 1] = nextY;
    onChange({ points: next });
  };

  return (
    <Group
      id={annotation.id}
      x={x}
      y={y}
      draggable={draggable}
      onDragEnd={(event) => onChange({ x: event.target.x(), y: event.target.y() })}
    >
      <Arrow
        points={points}
        stroke={stroke}
        fill={stroke}
        strokeWidth={strokeWidth}
        pointerLength={strokeWidth * 3}
        pointerWidth={strokeWidth * 3}
        lineCap="round"
        lineJoin="round"
        // Widen the clickable area without widening the drawn line.
        hitStrokeWidth={Math.max(strokeWidth * 3, 20)}
        shadowColor="#000000"
        shadowBlur={strokeWidth}
        shadowOpacity={0.3}
      />
      {selected &&
        ([
          [x1, y1, 0],
          [x2, y2, 1],
        ] as const).map(([handleX, handleY, index]) => (
          <Circle
            key={index}
            x={handleX}
            y={handleY}
            radius={handleRadius}
            fill="#ffffff"
            stroke={stroke}
            strokeWidth={handleRadius * 0.3}
            draggable
            // Without this the Group's own drag handler also fires and the arrow
            // slides away while you are adjusting one end of it.
            onDragStart={(event) => event.cancelBubble = true}
            onDragMove={(event) => {
              event.cancelBubble = true;
              moveEndpoint(index, event.target.x(), event.target.y());
            }}
            onDragEnd={(event) => {
              event.cancelBubble = true;
              moveEndpoint(index, event.target.x(), event.target.y());
            }}
          />
        ))}
    </Group>
  );
}
