import { Label, Tag, Text } from "react-konva";
import type Konva from "konva";

import {
  ANNOTATION_FONT,
  ANNOTATION_LINE_HEIGHT,
  TEXT_PADDING,
  type TextAnnotation,
} from "../../lib/types";

/**
 * A text annotation, optionally on an opaque plate.
 *
 * Paint calls this Opaque vs Transparent, and on a busy screenshot it is the
 * difference between a caption you can read and one lost in the picture behind
 * it.
 *
 * Built on Konva's `Label`, whose `Tag` sizes itself to the text it contains -
 * which matters because with a wrapping box the height is only known after the
 * text has been laid out. Sizing a plain rectangle to match would mean measuring
 * the text ourselves and keeping the two in step.
 */
interface Props {
  annotation: TextAnnotation;
  /** Scales sizes to the capture's DPI, as everywhere else. */
  unit: number;
  editing: boolean;
  draggable: boolean;
  onChange: (patch: Partial<TextAnnotation>) => void;
  onEdit: () => void;
}

export default function TextShape({
  annotation,
  unit,
  editing,
  draggable,
  onChange,
  onEdit,
}: Props) {
  const { x, y, text, fontSize, fill, background, boxWidth } = annotation;
  const padding = background ? TEXT_PADDING * unit : 0;

  return (
    <Label
      id={annotation.id}
      // Shifted out by the padding so switching the plate on grows it outwards
      // rather than pushing the words down and to the right.
      x={x - padding}
      y={y - padding}
      visible={!editing}
      draggable={draggable}
      onDblClick={onEdit}
      onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) =>
        onChange({ x: event.target.x() + padding, y: event.target.y() + padding })
      }
    >
      {/* Always present: a Label without a Tag has nothing to size against, and
          a transparent one still gives the words a hit area to be grabbed by. */}
      <Tag fill={background ?? "transparent"} />
      <Text
        text={text}
        // Stored in logical pixels; scaled here so the same number looks
        // identical on any capture's DPI.
        fontSize={fontSize * unit}
        fontFamily={ANNOTATION_FONT}
        lineHeight={ANNOTATION_LINE_HEIGHT}
        // Only set when a box was dragged out; undefined lets Konva size to the
        // text, which is the click case.
        width={boxWidth === undefined ? undefined : boxWidth + padding * 2}
        wrap="word"
        padding={padding}
        fontStyle="bold"
        fill={fill}
      />
    </Label>
  );
}
