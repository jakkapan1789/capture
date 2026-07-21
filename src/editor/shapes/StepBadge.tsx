import { Circle, Group, Text } from "react-konva";
import type { StepAnnotation } from "../../lib/types";

/**
 * A numbered badge.
 *
 * `number` is passed in rather than stored on the annotation - see
 * `stepNumbers()`. Deleting badge 2 of 5 renumbers the rest on the next render
 * with no bookkeeping.
 */
interface Props {
  annotation: StepAnnotation;
  number: number;
  selected: boolean;
  draggable: boolean;
  onChange: (patch: Partial<StepAnnotation>) => void;
}

export default function StepBadge({
  annotation,
  number,
  selected,
  draggable,
  onChange,
}: Props) {
  const { x, y, radius, fill } = annotation;
  const fontSize = radius * 1.15;

  return (
    <Group
      id={annotation.id}
      x={x}
      y={y}
      draggable={draggable}
      onDragEnd={(event) => onChange({ x: event.target.x(), y: event.target.y() })}
    >
      <Circle
        radius={radius}
        fill={fill}
        stroke="#ffffff"
        strokeWidth={selected ? radius * 0.16 : radius * 0.1}
        shadowColor="#000000"
        shadowBlur={radius * 0.4}
        shadowOpacity={0.35}
      />
      <Text
        text={String(number)}
        fontSize={fontSize}
        fontStyle="bold"
        fill="#ffffff"
        // Konva positions text by its top-left corner, so centre it by hand over a
        // box the size of the badge.
        width={radius * 2}
        height={radius * 2}
        offsetX={radius}
        offsetY={radius}
        align="center"
        verticalAlign="middle"
        listening={false}
      />
    </Group>
  );
}
