/**
 * The annotation editor.
 *
 * The stage works entirely in **image pixel space** and is scaled to fit the
 * viewport. That means annotation coordinates never depend on window size or zoom,
 * and exporting at full resolution is just `pixelRatio: 1 / fitScale`.
 *
 * "Viewport" here means the crop rectangle when one is set, or the whole image
 * otherwise. The content layer is offset by `-viewport.x/-viewport.y`, so cropping
 * changes what you see without touching a single stored coordinate.
 */

import Konva from "konva";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  Arrow,
  Ellipse,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
  Transformer,
} from "react-konva";

import { CopyIcon, DownloadIcon, ImageIcon, PasteIcon, TrashIcon } from "../lib/icons";
import {
  loadImageFromBlob,
  placeInViewport,
  readClipboardImage,
  toPngBlob,
  type PastedImage,
} from "../lib/images";
import type { ObjectClipboard } from "../App";
import ContextMenu from "../components/ContextMenu";
import {
  readCaptureImage,
  readCapturePiece,
  recognizeText,
  textRecognitionAvailable,
  saveAnnotations,
  saveCapturePiece,
  type CaptureMeta,
} from "../lib/ipc";
import {
  ACCENT,
  colorOf,
  colorPatch,
  createId,
  DEFAULT_FONT_SIZE,
  findCrop,
  isSelectable,
  persistableAnnotations,
  rectsIntersect,
  stepNumbers,
  type Annotation,
  type BlurAnnotation,
  type Rect as RectBounds,
  type Tool,
} from "../lib/types";
import TextResultDialog from "./TextResultDialog";
import Toolbar from "./Toolbar";
import ArrowShape from "./shapes/ArrowShape";
import BlurRegion from "./shapes/BlurRegion";
import ImageObject from "./shapes/ImageObject";
import EllipseShape from "./shapes/EllipseShape";
import StepBadge from "./shapes/StepBadge";
import { useAnnotations } from "./useAnnotations";

/** Shapes small enough to be an accidental click rather than a deliberate drag. */
const MIN_DRAW = 6;
/** Annotations are written back to disk this long after the last edit. */
const AUTOSAVE_DELAY = 600;
/**
 * Marks the screenshot itself. Uses `name` rather than `id` so it stays clear of
 * the id-based lookup the transformer does for annotations.
 */
const BACKGROUND_NAME = "capture-background";

const SHORTCUTS: Record<string, Tool> = {
  v: "select",
  a: "arrow",
  r: "rect",
  o: "ellipse",
  t: "text",
  s: "step",
  b: "blur",
  c: "crop",
  x: "cut",
  g: "ocr",
};

/** Tools whose selection box the transformer can resize. */
const RESIZABLE = new Set(["rect", "ellipse", "blur", "image", "fill"]);

interface Props {
  meta: CaptureMeta;
  image: HTMLImageElement;
  initialAnnotations: Annotation[];
  onCopy: (blob: Blob) => Promise<void>;
  onSave: (blob: Blob) => Promise<void>;
  status: string | null;
  onNotify: (message: string) => void;
  /** Capture and settings buttons, pinned to the far right of the toolbar. */
  actions: ReactNode;
  /** Copied objects, owned by the app so they outlive a capture switch. */
  clipboard: ObjectClipboard;
  onClipboardChange: (clipboard: ObjectClipboard) => void;
}

interface Draft {
  tool: Tool | "marquee";
  startX: number;
  startY: number;
  x: number;
  y: number;
}

function draftBounds(draft: Draft): RectBounds {
  return {
    x: Math.min(draft.startX, draft.x),
    y: Math.min(draft.startY, draft.y),
    width: Math.abs(draft.x - draft.startX),
    height: Math.abs(draft.y - draft.startY),
  };
}

export default function Editor({
  meta,
  image,
  initialAnnotations,
  onCopy,
  onSave,
  status,
  onNotify,
  actions,
  clipboard,
  onClipboardChange,
}: Props) {
  const {
    annotations,
    selectedIds,
    setSelectedIds,
    select,
    dirty,
    load,
    add,
    update,
    remove,
    replaceAll,
    reorderStep,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useAnnotations();

  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fitScale, setFitScale] = useState(1);
  /**
   * Style for newly drawn annotations, and the value the toolbar shows.
   *
   * `fontSize` is in logical pixels; it is multiplied by `unit` at render time so
   * a given number looks the same on any capture.
   */
  const [style, setStyle] = useState({ color: ACCENT, fontSize: DEFAULT_FONT_SIZE });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    /** Where the click landed in image pixels, so "Paste here" is literal. */
    imageX: number;
    imageY: number;
    targetId: string | null;
  } | null>(null);

  /**
   * Pixels for pasted images, keyed by annotation id.
   *
   * Kept outside the annotation list because it is session state: these never go
   * to disk, so they must not be part of what autosave serialises.
   */
  const [externalImages, setExternalImages] = useState<Map<string, CanvasImageSource>>(
    () => new Map(),
  );

  /**
   * Images of other captures, for cut-outs pasted in from them.
   *
   * A `capture` source is only coordinates, so a piece taken from another
   * screenshot needs that screenshot loaded to draw itself. Cached by capture id
   * and shared by every annotation pointing at it.
   */
  const [sourceImages, setSourceImages] = useState<Map<string, HTMLImageElement>>(
    () => new Map(),
  );
  const loadingSources = useRef(new Set<string>());
  /**
   * Pixels for cut-out pieces, keyed by piece id.
   *
   * A piece cut in this session holds the canvas it was rasterised into; one
   * reopened from disk holds an image element. Konva draws either.
   */
  const [pieceImages, setPieceImages] = useState<Map<string, CanvasImageSource>>(
    () => new Map(),
  );
  const loadingPieces = useRef(new Set<string>());
  /**
   * Whether this build can read text at all.
   *
   * macOS uses Vision; Windows has no implementation yet. Asked once so the
   * toolbar can grey the tool out instead of letting someone drag a region and
   * only then be told it does nothing.
   */
  const [canReadText, setCanReadText] = useState(false);
  /** Lines OCR found, shown for review. Null when the dialog is closed. */
  const [foundText, setFoundText] = useState<string[] | null>(null);

  useEffect(() => {
    void textRecognitionAvailable()
      .then(setCanReadText)
      .catch(() => setCanReadText(false));
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentLayerRef = useRef<Konva.Layer>(null);
  const overlayLayerRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);

  const crop = findCrop(annotations);
  const cropping = tool === "crop";

  /**
   * What the stage shows. While the crop tool is active we deliberately show the
   * whole image so the crop can be widened again - you cannot re-grow a crop you
   * are not allowed to see outside of.
   */
  const viewport: RectBounds = useMemo(
    () =>
      !cropping && crop
        ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
        : { x: 0, y: 0, width: meta.width, height: meta.height },
    [cropping, crop, meta.width, meta.height],
  );

  const selected = annotations.filter((annotation) => selectedIds.includes(annotation.id));
  const single = selected.length === 1 ? selected[0] : null;
  const numbers = stepNumbers(annotations);

  /**
   * Annotation sizes scale with the capture's DPI.
   *
   * A Retina capture is twice as many pixels for the same visual area, so a
   * fixed 3px arrow would look hairline on it. Deriving from `scaleFactor` keeps
   * annotations looking identical across displays.
   */
  const unit = Math.max(1, meta.scaleFactor);
  const strokeWidth = 3 * unit;

  useEffect(() => {
    load(initialAnnotations);
  }, [meta.id, initialAnnotations, load]);

  /**
   * The zoom at which the capture matches the size it had on screen.
   *
   * A capture is stored in *physical* pixels, so on a 2x display it is twice the
   * pixel dimensions of the area that was actually grabbed. Showing it 1:1 makes
   * everything look inflated to double size; dividing by the scale factor shows
   * it exactly as it looked on screen.
   */
  const naturalScale = 1 / Math.max(1, meta.scaleFactor);

  // Fit the visible area into the space available, never magnifying past its
  // natural on-screen size.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const apply = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      setFitScale(Math.min(width / viewport.width, height / viewport.height, naturalScale));
    };

    // Measure synchronously first, before the browser paints. Relying on the
    // ResizeObserver's initial callback instead would paint one frame at the
    // previous capture's scale and then correct it - visible as a flinch every
    // time you switch pictures.
    //
    // `clientWidth` includes padding, so subtract it: the padding is space the
    // image must never grow into (see `.canvas-area`).
    const style = getComputedStyle(container);
    apply(
      container.clientWidth -
        (parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)),
      container.clientHeight -
        (parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)),
    );

    // `contentRect` already excludes padding, so later resizes need no maths.
    const observer = new ResizeObserver(([entry]) => {
      apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [viewport.width, viewport.height, naturalScale]);

  // Autosave. Annotations are the only thing that changes after a capture, and
  // losing them to a forgotten Ctrl+S would defeat the point of the gallery.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      void saveAnnotations(meta.id, persistableAnnotations(annotations)).catch((error) =>
        console.error("autosave failed", error),
      );
    }, AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [meta.id, annotations, dirty]);

  // The debounce timer is cleared on unmount, so an edit made in the last 600ms
  // before switching captures would otherwise be dropped. Flush it instead.
  const pending = useRef({ id: meta.id, annotations });
  pending.current = { id: meta.id, annotations };

  useEffect(() => {
    return () => {
      if (!dirty.current) return;
      void saveAnnotations(
        pending.current.id,
        persistableAnnotations(pending.current.annotations),
      ).catch((error) => console.error("final save failed", error));
    };
  }, [dirty]);

  // Keep the transformer bound to the selection. A single rectangular object gets
  // resize handles; a multi-selection only gets a bounding box, because scaling
  // several unrelated shapes at once produces nonsense.
  useEffect(() => {
    const transformer = transformerRef.current;
    const layer = contentLayerRef.current;
    if (!transformer || !layer) return;

    if (cropping) {
      const node = crop ? layer.findOne(`#${crop.id}`) : undefined;
      transformer.nodes(node ? [node] : []);
      transformer.resizeEnabled(true);
      transformer.getLayer()?.batchDraw();
      return;
    }

    const nodes = selected
      .filter(isSelectable)
      .map((annotation) => layer.findOne(`#${annotation.id}`))
      .filter((node): node is Konva.Node => Boolean(node));

    const resizable = selected.length === 1 && RESIZABLE.has(selected[0].type);
    transformer.nodes(selected.length > 1 || resizable ? nodes : []);
    transformer.resizeEnabled(resizable);
    transformer.getLayer()?.batchDraw();
  }, [selected, annotations, cropping, crop]);

  /* ---------- pasting ---------- */

  const addPastedImage = useCallback(
    (pasted: PastedImage, at?: { x: number; y: number }) => {
      const id = createId();
      const box = placeInViewport(pasted, viewport, at);

      setExternalImages((previous) => new Map(previous).set(id, pasted.source));
      add({ id, type: "image", source: { kind: "external" }, ...box });
      setTool("select");
    },
    [add, viewport],
  );

  const pasteFromClipboard = useCallback(
    async (at?: { x: number; y: number }) => {
      try {
        const pasted = await readClipboardImage();
        if (!pasted) {
          onNotify("Nothing to paste");
          return;
        }
        addPastedImage(pasted, at);
        // Pasted pixels are session-only, so say so once rather than letting it
        // be discovered after a reload.
        onNotify("Image pasted - it will be flattened on export");
      } catch (error) {
        onNotify(`Paste failed: ${error}`);
      }
    },
    [addPastedImage, onNotify],
  );

  // Fetch any foreign capture a cut-out points at, once each.
  useEffect(() => {
    const wanted = new Set<string>();
    for (const annotation of annotations) {
      if (annotation.type !== "image" || annotation.source.kind !== "capture") continue;
      const id = annotation.source.captureId;
      if (id && id !== meta.id && !sourceImages.has(id) && !loadingSources.current.has(id)) {
        wanted.add(id);
      }
    }
    if (wanted.size === 0) return;

    for (const id of wanted) loadingSources.current.add(id);
    let cancelled = false;

    void (async () => {
      for (const id of wanted) {
        try {
          const image = await loadImageFromBlob(await readCaptureImage(id));
          if (cancelled) return;
          setSourceImages((previous) => new Map(previous).set(id, image));
        } catch (error) {
          // The source capture may since have been deleted; the piece simply
          // will not draw, which ImageObject already handles.
          console.error("could not load source capture", id, error);
        } finally {
          loadingSources.current.delete(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [annotations, meta.id, sourceImages]);

  // Fetch the pixels of any cut-out piece, once each. A piece cut in this
  // session is already in the map, so this only runs for a reopened capture.
  useEffect(() => {
    const wanted = new Map<string, string>();
    for (const annotation of annotations) {
      if (annotation.type !== "image" || annotation.source.kind !== "piece") continue;
      const { pieceId, captureId } = annotation.source;
      if (!pieceImages.has(pieceId) && !loadingPieces.current.has(pieceId)) {
        wanted.set(pieceId, captureId);
      }
    }
    if (wanted.size === 0) return;

    for (const pieceId of wanted.keys()) loadingPieces.current.add(pieceId);
    let cancelled = false;

    void (async () => {
      for (const [pieceId, captureId] of wanted) {
        try {
          const image = await loadImageFromBlob(await readCapturePiece(captureId, pieceId));
          if (cancelled) return;
          setPieceImages((previous) => new Map(previous).set(pieceId, image));
        } catch (error) {
          // The file may be gone - a capture deleted from under a copy of its
          // piece. ImageObject renders nothing rather than throwing.
          console.error("could not load cut-out", pieceId, error);
        } finally {
          loadingPieces.current.delete(pieceId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [annotations, pieceImages]);

  /**
   * Flatten a rectangle of the picture exactly as it currently looks.
   *
   * Cut has to take the annotations with it - cutting a marked-up screenshot and
   * getting bare pixels back is not what the tool appears to do. That means a
   * genuine rasterisation, so the same two precautions as `exportBlob` apply:
   * the overlay layer is hidden, and the selection is cleared through
   * `flushSync` because an arrow's endpoint handles live on the content layer
   * and would otherwise be baked into the piece.
   */
  const rasterizeRegion = useCallback(
    (bounds: RectBounds): HTMLCanvasElement | null => {
      const stage = stageRef.current;
      if (!stage) return null;

      const overlay = overlayLayerRef.current;
      const previousSelection = selectedIds;
      flushSync(() => setSelectedIds([]));
      overlay?.hide();

      try {
        // Read the scale off the stage for the same reason `exportBlob` does:
        // it is what was actually rendered, whatever the state says.
        const scale = stage.scaleX() || 1;
        return stage.toCanvas({
          // Konva wants absolute stage coordinates; annotations are in image
          // coordinates, which the viewport offset sits between.
          x: (bounds.x - viewport.x) * scale,
          y: (bounds.y - viewport.y) * scale,
          width: bounds.width * scale,
          height: bounds.height * scale,
          // Undo the fit-to-window scale so the piece is cut at the capture's
          // native resolution rather than at screen resolution.
          pixelRatio: 1 / scale,
        });
      } finally {
        overlay?.show();
        setSelectedIds(previousSelection);
      }
    },
    [selectedIds, setSelectedIds, viewport.x, viewport.y],
  );

  /* ---------- object clipboard ---------- */


  const copySelection = useCallback(
    (ids: string[]) => {
      const items = annotations.filter(
        (annotation) => ids.includes(annotation.id) && isSelectable(annotation),
      );
      if (items.length === 0) return;

      // Carry the pixels of any session-only images along with the objects,
      // otherwise pasting them into another capture yields empty frames.
      const images = new Map<string, CanvasImageSource>();
      for (const item of items) {
        // A cut-out's pixels travel too. Pasted into another capture it needs a
        // file of its own there, and this editor is unmounted the moment the
        // capture changes - so the pixels have to be taken along now.
        const pixels =
          externalImages.get(item.id) ??
          (item.type === "image" && item.source.kind === "piece"
            ? pieceImages.get(item.source.pieceId)
            : undefined);
        if (pixels) images.set(item.id, pixels);
      }

      // Stamp the origin on anything saved before `captureId` existed. Without
      // it the copy would mean "this rectangle of whatever is open" once pasted
      // somewhere else.
      const copies = items.map((item) => {
        const copy = structuredClone(item);
        if (copy.type === "image" && copy.source.kind === "capture" && !copy.source.captureId) {
          copy.source.captureId = meta.id;
        }
        return copy;
      });

      onClipboardChange({ annotations: copies, images });
      onNotify(items.length > 1 ? `Copied ${items.length} objects` : "Copied");
    },
    [annotations, externalImages, pieceImages, meta.id, onClipboardChange, onNotify],
  );

  /**
   * Paste the copied objects, with their top-left corner at `at` when given
   * (right-click "Paste here") or nudged off the originals otherwise.
   */
  const pasteObjects = useCallback(
    (at?: { x: number; y: number }) => {
      const items = clipboard.annotations;
      if (items.length === 0) return false;

      const left = Math.min(...items.map((item) => item.x));
      const top = Math.min(...items.map((item) => item.y));
      const nudge = 16 * unit;
      const dx = at ? at.x - left : nudge;
      const dy = at ? at.y - top : nudge;

      const copies: Annotation[] = [];
      const extraImages = new Map<string, CanvasImageSource>();
      const newPieces = new Map<
        string,
        { pixels: CanvasImageSource; width: number; height: number }
      >();

      for (const item of items) {
        const copy = { ...structuredClone(item), id: createId(), x: item.x + dx, y: item.y + dy };
        // A pasted copy of a session-only image needs its own entry in the
        // pixel map, or it would render as nothing.
        if (copy.type === "image" && copy.source.kind === "external") {
          const pixels = clipboard.images.get(item.id);
          if (pixels) extraImages.set(copy.id, pixels);
        }

        // A cut-out pasted into a different capture is re-homed: it gets its
        // own piece file here. Sharing the original would leave it pointing at
        // a file the *other* capture is free to prune the moment its own copy
        // is undone or deleted.
        if (
          copy.type === "image" &&
          copy.source.kind === "piece" &&
          copy.source.captureId !== meta.id
        ) {
          const pixels = clipboard.images.get(item.id);
          if (pixels) {
            const pieceId = createId();
            copy.source = { kind: "piece", captureId: meta.id, pieceId };
            newPieces.set(pieceId, { pixels, width: copy.width, height: copy.height });
          }
          // Without pixels the original reference is kept: it still draws for as
          // long as that file is there, which beats rendering nothing.
        }
        copies.push(copy as Annotation);
      }

      if (extraImages.size > 0) {
        setExternalImages((previous) => new Map([...previous, ...extraImages]));
      }

      if (newPieces.size > 0) {
        setPieceImages((previous) => {
          const next = new Map(previous);
          for (const [pieceId, piece] of newPieces) next.set(pieceId, piece.pixels);
          return next;
        });
        for (const [pieceId, piece] of newPieces) {
          void toPngBlob(piece.pixels, piece.width, piece.height)
            .then((blob) => blob && saveCapturePiece(meta.id, pieceId, blob))
            .catch((error) => console.error("could not store pasted cut-out", error));
        }
      }
      replaceAll([...annotations, ...copies]);
      setSelectedIds(copies.map((copy) => copy.id));
      return true;
    },
    [annotations, clipboard, meta.id, replaceAll, setSelectedIds, unit],
  );

  /**
   * One paste action for the menu and Cmd+V.
   *
   * Objects copied in-app win, because that is the more recent and more specific
   * intent. Falling through to the system clipboard is what makes "Copy whole
   * image" - and anything copied from another application - pasteable here,
   * including after switching to a different capture.
   */
  const paste = useCallback(
    (at?: { x: number; y: number }) => {
      if (pasteObjects(at)) return;
      void pasteFromClipboard(at);
    },
    [pasteObjects, pasteFromClipboard],
  );

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal keys while the text editor or a modal is open.
      if (editingId) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;

      // Undo/redo. Cmd+Shift+Z is the mac redo; Ctrl+Y is the Windows one.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection(selectedIds);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        paste();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(annotations.filter(isSelectable).map((annotation) => annotation.id));
        return;
      }

      if (event.key === "Escape") {
        // Escape dismisses the menu first, before touching the selection.
        if (menu) {
          setMenu(null);
          return;
        }
        setSelectedIds([]);
        setTool("select");
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.length > 0) {
        event.preventDefault();
        remove(selectedIds);
        return;
      }

      const shortcut = SHORTCUTS[event.key.toLowerCase()];
      if (shortcut && !event.metaKey && !event.ctrlKey) setTool(shortcut);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    editingId,
    selectedIds,
    menu,
    annotations,
    remove,
    setSelectedIds,
    paste,
    copySelection,
    undo,
    redo,
  ]);

  /* ---------- pointer ---------- */

  /**
   * Pointer position in image pixels.
   *
   * Read off the content layer rather than the stage so the crop offset is
   * already accounted for.
   */
  const pointer = useCallback((): { x: number; y: number } | null => {
    return contentLayerRef.current?.getRelativePointerPosition() ?? null;
  }, []);

  /**
   * The annotation a Konva node belongs to, or null for the background.
   *
   * Walks up the tree because the node under the cursor is often an inner part
   * of a shape - the `Arrow` inside an arrow's Group, or a badge's `Circle` -
   * and only the outermost node carries the annotation id.
   */
  const annotationIdAt = useCallback(
    (node: Konva.Node | null): string | null => {
      const ids = new Set(annotations.filter(isSelectable).map((annotation) => annotation.id));
      for (let current = node; current; current = current.getParent()) {
        const id = current.id();
        if (id && ids.has(id)) return id;
      }
      return null;
    },
    [annotations],
  );

  const onStageMouseDown = (event: Konva.KonvaEventObject<MouseEvent>) => {
    // Konva fires mousedown for every button. Without this, a right-click would
    // begin drawing a shape underneath the context menu, and would clear the
    // selection before the menu had a chance to act on it.
    if (event.evt.button !== 0) return;

    // Selection chrome is not canvas. Transformer anchors live on the overlay
    // layer and carry no annotation id, so without this they fall through to the
    // "empty space" branch below, which clears the selection and detaches the
    // transformer the instant you grab a handle - making resize impossible for
    // every resizable type.
    if (event.target.getLayer() === overlayLayerRef.current) return;

    const position = pointer();
    if (!position) return;

    if (tool !== "select") {
      setDraft({ tool, startX: position.x, startY: position.y, x: position.x, y: position.y });
      return;
    }

    const id = annotationIdAt(event.target);
    if (id) {
      select(id, event.evt.shiftKey);
      return;
    }

    // Empty space: start a marquee. Shift keeps whatever is already selected.
    if (!event.evt.shiftKey) setSelectedIds([]);
    setDraft({ tool: "marquee", startX: position.x, startY: position.y, ...position });
  };

  /** Pointer position in image pixels, from a raw DOM event, clamped to the image.
   *
   * Used while dragging because the pointer routinely leaves the canvas - which
   * is exactly what happens when you drag a crop out to the edge of the picture.
   */
  const toImagePoint = useCallback(
    (event: MouseEvent) => {
      const container = stageRef.current?.container();
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
      return {
        x: clamp((event.clientX - rect.left) / fitScale + viewport.x, meta.width),
        y: clamp((event.clientY - rect.top) / fitScale + viewport.y, meta.height),
      };
    },
    [fitScale, viewport.x, viewport.y, meta.width, meta.height],
  );

  /** Ids of annotations whose rendered bounds intersect `bounds`. */
  const idsWithin = (bounds: RectBounds): string[] => {
    const layer = contentLayerRef.current;
    if (!layer) return [];

    return annotations.filter(isSelectable).reduce<string[]>((ids, annotation) => {
      const node = layer.findOne(`#${annotation.id}`);
      if (!node) return ids;
      // Ask Konva for the real rendered box - it accounts for stroke, arrow
      // heads and text metrics, which we would otherwise have to reimplement.
      const box = node.getClientRect({ relativeTo: layer });
      if (rectsIntersect(bounds, box)) ids.push(annotation.id);
      return ids;
    }, []);
  };

  const finishDraft = (draft: Draft) => {
    const bounds = draftBounds(draft);
    const { startX, startY, x, y } = draft;
    const currentTool = draft.tool;
    setDraft(null);

    if (currentTool === "marquee") {
      const hits = idsWithin(bounds);
      setSelectedIds((previous) => Array.from(new Set([...previous, ...hits])));
      return;
    }

    switch (currentTool) {
      case "arrow": {
        if (Math.hypot(x - startX, y - startY) < MIN_DRAW) return;
        add({
          id: createId(),
          type: "arrow",
          x: startX,
          y: startY,
          points: [0, 0, x - startX, y - startY],
          stroke: style.color,
          strokeWidth,
        });
        return;
      }
      case "rect": {
        if (bounds.width < MIN_DRAW || bounds.height < MIN_DRAW) return;
        add({ id: createId(), type: "rect", ...bounds, stroke: style.color, strokeWidth });
        return;
      }
      case "ellipse": {
        if (bounds.width < MIN_DRAW || bounds.height < MIN_DRAW) return;
        add({ id: createId(), type: "ellipse", ...bounds, stroke: style.color, strokeWidth });
        return;
      }
      case "blur": {
        if (bounds.width < MIN_DRAW || bounds.height < MIN_DRAW) return;
        add({ id: createId(), type: "blur", ...bounds, mode: "blur", strength: 12 * unit });
        return;
      }
      case "crop": {
        if (bounds.width < MIN_DRAW || bounds.height < MIN_DRAW) return;
        // Only ever one crop: replace any previous one rather than stacking.
        const id = crop?.id ?? createId();
        replaceAll([
          ...annotations.filter((annotation) => annotation.type !== "crop"),
          { id, type: "crop", ...bounds },
        ]);
        // Apply it straight away, like Paint does. Staying in crop mode would
        // leave the whole image on screen and look like nothing had happened.
        // Pressing C again reopens the full image to adjust the box.
        setTool("select");
        return;
      }
      case "cut": {
        if (bounds.width < MIN_DRAW || bounds.height < MIN_DRAW) return;
        // Paint's cut: the piece lifts out and the area it left turns white.
        // The piece starts exactly over its source, so nothing appears to move
        // until you drag it - which is precisely the behaviour being copied.
        //
        // Both objects are added in one call so they are a single undo step, and
        // the hole is appended first so it sits underneath the piece.
        const holeId = createId();
        const pieceId = createId();

        // Snapshot *before* the hole and the piece are added, or the cut would
        // contain the white rectangle it is about to leave behind.
        const canvas = rasterizeRegion(bounds);
        if (!canvas) return;

        // The canvas is a valid image source in its own right, so the piece
        // draws immediately - no encode, no round trip, no flicker.
        setPieceImages((previous) => new Map(previous).set(pieceId, canvas));
        canvas.toBlob((blob) => {
          if (!blob) return;
          void saveCapturePiece(meta.id, pieceId, blob).catch((error) => {
            // The piece still works for this session; it just will not come
            // back after a reopen, which the user should know about.
            console.error("could not store cut-out", error);
            onNotify("Cut-out could not be saved - it will be lost on reopen");
          });
        }, "image/png");

        replaceAll([
          ...annotations,
          { id: holeId, type: "fill", ...bounds, fill: "#ffffff" },
          {
            id: pieceId,
            type: "image",
            ...bounds,
            source: { kind: "piece", captureId: meta.id, pieceId },
          },
        ]);
        setSelectedIds([pieceId]);
        setTool("select");
        return;
      }
      case "ocr": {
        if (bounds.width < MIN_DRAW || bounds.height < MIN_DRAW) return;

        // Read the picture *as it looks*, like Cut does. Reading the original
        // pixels instead would let OCR see straight through a blur that was put
        // there to hide something - the one place where being faithful to the
        // stored image would be a privacy bug rather than a feature.
        const canvas = rasterizeRegion(bounds);
        if (!canvas) return;

        setTool("select");
        onNotify("Reading text...");
        canvas.toBlob((blob) => {
          if (!blob) return;
          void (async () => {
            // Reading and copying are reported separately. Wrapping both in one
            // catch blamed OCR for a clipboard failure, which sent an entirely
            // correct recognition off to be debugged as a broken one.
            let lines;
            try {
              lines = await recognizeText(blob);
            } catch (error) {
              onNotify(`Could not read text: ${error}`);
              return;
            }

            if (lines.length === 0) {
              onNotify("No text found there");
              return;
            }

            // Shown rather than copied: OCR is good but not perfect, and a
            // mistake handed straight to the clipboard is only discovered after
            // it has been pasted somewhere.
            setFoundText(lines.map((line) => line.text));
          })();
        }, "image/png");
        return;
      }
      case "step": {
        add({
          id: createId(),
          type: "step",
          x: startX,
          y: startY,
          radius: 18 * unit,
          fill: style.color,
        });
        return;
      }
      case "text": {
        const id = createId();
        add({
          id,
          type: "text",
          x: startX,
          y: startY,
          text: "Text",
          fontSize: style.fontSize,
          fill: style.color,
        });
        setEditingId(id);
        setTool("select");
        return;
      }
      default:
        return;
    }
  };

  /**
   * Track the drag on `window`, not on the stage.
   *
   * Konva only sees events over its own canvas, so releasing the button past the
   * edge of the picture would never finish the shape and would leave the draft
   * stuck on screen. Cropping in particular almost always ends outside the image.
   */
  const finishRef = useRef(finishDraft);
  finishRef.current = finishDraft;
  const toImagePointRef = useRef(toImagePoint);
  toImagePointRef.current = toImagePoint;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Registered once, for the whole life of the editor, rather than switched on
  // when a draft appears. Attaching them inside a `draft !== null` effect looks
  // tidier but loses the race: the effect only runs after React has re-rendered
  // from the mousedown, so a quick click - which is the entire interaction for
  // the step and text tools - can deliver its mouseup before they exist.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!draftRef.current) return;
      const point = toImagePointRef.current(event);
      if (!point) return;
      setDraft((previous) => (previous ? { ...previous, ...point } : previous));
    };

    const onUp = (event: MouseEvent) => {
      const current = draftRef.current;
      if (!current) return;
      draftRef.current = null;
      const point = toImagePointRef.current(event);
      finishRef.current(point ? { ...current, ...point } : current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /* ---------- dragging a multi-selection ---------- */

  /**
   * Konva drags one node at a time, so moving a multi-selection means mirroring
   * the dragged node's delta onto the others. The mirrored nodes are moved
   * imperatively during the drag and only committed to state on drop, which
   * keeps a 20-object drag smooth.
   */
  const groupDrag = useRef<{
    leader: Konva.Node;
    startX: number;
    startY: number;
    followers: { id: string; node: Konva.Node; x: number; y: number }[];
  } | null>(null);

  const onLayerDragStart = (event: Konva.KonvaEventObject<DragEvent>) => {
    const layer = contentLayerRef.current;
    const id = annotationIdAt(event.target);
    if (!layer || !id || selectedIds.length < 2 || !selectedIds.includes(id)) return;

    const leader = layer.findOne(`#${id}`);
    if (!leader) return;

    const followers = selectedIds
      .filter((other) => other !== id)
      .map((other) => {
        const node = layer.findOne(`#${other}`);
        return node ? { id: other, node, x: node.x(), y: node.y() } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    groupDrag.current = { leader, startX: leader.x(), startY: leader.y(), followers };
  };

  const onLayerDragMove = () => {
    const drag = groupDrag.current;
    if (!drag) return;

    const dx = drag.leader.x() - drag.startX;
    const dy = drag.leader.y() - drag.startY;
    for (const follower of drag.followers) {
      follower.node.position({ x: follower.x + dx, y: follower.y + dy });
    }
  };

  const onLayerDragEnd = () => {
    const drag = groupDrag.current;
    groupDrag.current = null;
    if (!drag) return;

    const dx = drag.leader.x() - drag.startX;
    const dy = drag.leader.y() - drag.startY;
    for (const follower of drag.followers) {
      update(follower.id, { x: follower.x + dx, y: follower.y + dy } as Partial<Annotation>);
    }
  };

  /* ---------- export ---------- */

  /**
   * Flatten the stage to a PNG at the capture's native resolution.
   *
   * This is the only point where annotations stop being objects. The stored PNG
   * and JSON are untouched.
   */
  const exportBlob = useCallback(async (): Promise<Blob> => {
    const stage = stageRef.current;
    if (!stage) throw new Error("stage is not ready");

    const overlay = overlayLayerRef.current;
    const previousSelection = selectedIds;

    // Hiding the overlay layer takes care of the transformer, but an arrow's
    // endpoint handles are drawn on the content layer. `flushSync` forces the
    // deselect to render *before* we rasterize, so they never reach the export.
    //
    // Leaving crop mode matters just as much: while it is active the stage shows
    // the whole image, and exporting from there would silently ignore the crop.
    flushSync(() => {
      setSelectedIds([]);
      setTool("select");
    });
    overlay?.hide();

    try {
      // Read the scale off the stage rather than from `fitScale` state. Leaving
      // crop mode above changes the viewport, and the state that describes it is
      // only recomputed in a layout effect - so `fitScale` can still hold the
      // previous value at this exact moment. `stage.scaleX()` is whatever was
      // actually rendered, which makes the output exactly viewport-sized either way.
      const scale = stage.scaleX() || 1;
      const dataUrl = stage.toDataURL({ pixelRatio: 1 / scale, mimeType: "image/png" });
      const response = await fetch(dataUrl);
      return await response.blob();
    } finally {
      overlay?.show();
      setSelectedIds(previousSelection);
    }
  }, [fitScale, selectedIds, setSelectedIds]);

  const editing = annotations.find(
    (annotation) => annotation.id === editingId && annotation.type === "text",
  );

  const onStageContextMenu = (event: Konva.KonvaEventObject<PointerEvent>) => {
    // Suppress the webview's own menu ("Reload", "Inspect Element", ...).
    event.evt.preventDefault();

    const targetId = annotationIdAt(event.target);
    // Right-clicking a shape selects it too, the way every other editor behaves -
    // otherwise "Delete" in the menu would act on something that isn't highlighted.
    // An existing multi-selection is kept so it can be acted on in one go.
    if (targetId && !selectedIds.includes(targetId)) select(targetId, false);

    const point = pointer() ?? { x: 0, y: 0 };

    setMenu({
      x: event.evt.clientX,
      y: event.evt.clientY,
      imageX: point.x,
      imageY: point.y,
      targetId,
    });
  };

  const runAndClose = (action: (blob: Blob) => Promise<void>) => {
    setMenu(null);
    void exportBlob().then(action);
  };

  /* ---------- style controls ---------- */

  /** Set the colour for anything selected that has one, and for the next shape. */
  const applyColor = (color: string) => {
    setStyle((previous) => ({ ...previous, color }));
    for (const annotation of selected) {
      const patch = colorPatch(annotation, color);
      if (patch) update(annotation.id, patch);
    }
  };

  const applyFontSize = (fontSize: number) => {
    setStyle((previous) => ({ ...previous, fontSize }));
    for (const annotation of selected) {
      if (annotation.type === "text") update(annotation.id, { fontSize });
    }
  };

  // Show the controls' current value from the selection when there is one, so the
  // toolbar reflects what you are looking at rather than what you last picked.
  const activeColor = (single && colorOf(single)) ?? style.color;
  const activeFontSize = single?.type === "text" ? single.fontSize : style.fontSize;
  const showColor =
    ["text", "arrow", "rect", "step"].includes(tool) ||
    selected.some((annotation) => colorOf(annotation) !== null);
  const showFontSize = tool === "text" || selected.some((a) => a.type === "text");

  const draggableNow = tool === "select";
  const menuDeletable = menu ? menu.targetId !== null || selectedIds.length > 0 : false;

  return (
    <div className="editor">
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        disabledTools={canReadText ? undefined : ["ocr"]}
        selected={single}
        hasCrop={Boolean(crop)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        showColor={showColor}
        color={activeColor}
        onColorChange={applyColor}
        showFontSize={showFontSize}
        fontSize={activeFontSize}
        onFontSizeChange={applyFontSize}
        onResetCrop={() => crop && remove([crop.id])}
        onReorderStep={(delta) => single && reorderStep(single.id, delta)}
        onToggleBlurMode={() =>
          single?.type === "blur" &&
          update(single.id, {
            mode: single.mode === "blur" ? "pixelate" : "blur",
          } as Partial<BlurAnnotation>)
        }
        status={status}
        actions={actions}
      />

      <div className="canvas-area" ref={containerRef}>
        <div className="canvas-frame" style={{ width: viewport.width * fitScale }}>
          <Stage
            ref={stageRef}
            width={viewport.width * fitScale}
            height={viewport.height * fitScale}
            scaleX={fitScale}
            scaleY={fitScale}
            onMouseDown={onStageMouseDown}
            onContextMenu={onStageContextMenu}
            style={{ cursor: tool === "select" ? "default" : "crosshair" }}
          >
            {/* The crop offset lives here, so every annotation coordinate stays
                in unchanged image-pixel space. */}
            <Layer
              ref={contentLayerRef}
              x={-viewport.x}
              y={-viewport.y}
              onDragStart={onLayerDragStart}
              onDragMove={onLayerDragMove}
              onDragEnd={onLayerDragEnd}
            >
              <KonvaImage
                name={BACKGROUND_NAME}
                image={image}
                width={meta.width}
                height={meta.height}
              />

              {annotations.map((annotation) => {
                const isSelected = selectedIds.includes(annotation.id);

                switch (annotation.type) {
                  case "arrow":
                    return (
                      <ArrowShape
                        key={annotation.id}
                        annotation={annotation}
                        selected={isSelected && selected.length === 1}
                        draggable={draggableNow}
                        handleRadius={8 * unit}
                        onChange={(patch) => update(annotation.id, patch)}
                      />
                    );
                  case "rect":
                    return (
                      <Rect
                        key={annotation.id}
                        id={annotation.id}
                        x={annotation.x}
                        y={annotation.y}
                        width={annotation.width}
                        height={annotation.height}
                        stroke={annotation.stroke}
                        strokeWidth={annotation.strokeWidth}
                        cornerRadius={4 * unit}
                        draggable={draggableNow}
                        onDragEnd={(event) =>
                          update(annotation.id, { x: event.target.x(), y: event.target.y() })
                        }
                        onTransformEnd={(event) => {
                          const node = event.target;
                          const scaleX = node.scaleX();
                          const scaleY = node.scaleY();
                          node.scaleX(1);
                          node.scaleY(1);
                          update(annotation.id, {
                            x: node.x(),
                            y: node.y(),
                            width: Math.max(8, node.width() * scaleX),
                            height: Math.max(8, node.height() * scaleY),
                          });
                        }}
                      />
                    );
                  case "ellipse":
                    return (
                      <EllipseShape
                        key={annotation.id}
                        annotation={annotation}
                        draggable={draggableNow}
                        onChange={(patch) => update(annotation.id, patch)}
                      />
                    );
                  case "text":
                    return (
                      <Text
                        key={annotation.id}
                        id={annotation.id}
                        x={annotation.x}
                        y={annotation.y}
                        text={annotation.text}
                        // Stored in logical pixels; scaled here so the same
                        // number looks identical on any capture's DPI.
                        fontSize={annotation.fontSize * unit}
                        fontStyle="bold"
                        fill={annotation.fill}
                        draggable={draggableNow}
                        visible={annotation.id !== editingId}
                        onDblClick={() => setEditingId(annotation.id)}
                        onDragEnd={(event) =>
                          update(annotation.id, { x: event.target.x(), y: event.target.y() })
                        }
                      />
                    );
                  case "step":
                    return (
                      <StepBadge
                        key={annotation.id}
                        annotation={annotation}
                        number={numbers.get(annotation.id) ?? 1}
                        selected={isSelected}
                        draggable={draggableNow}
                        onChange={(patch) => update(annotation.id, patch)}
                      />
                    );
                  case "blur":
                    return (
                      <BlurRegion
                        key={annotation.id}
                        annotation={annotation}
                        image={image}
                        draggable={draggableNow}
                        onChange={(patch) => update(annotation.id, patch)}
                      />
                    );
                  case "fill":
                    return (
                      <Rect
                        key={annotation.id}
                        id={annotation.id}
                        x={annotation.x}
                        y={annotation.y}
                        width={annotation.width}
                        height={annotation.height}
                        fill={annotation.fill}
                        draggable={draggableNow}
                        onDragEnd={(event) =>
                          update(annotation.id, { x: event.target.x(), y: event.target.y() })
                        }
                        onTransformEnd={(event) => {
                          const node = event.target;
                          const scaleX = node.scaleX();
                          const scaleY = node.scaleY();
                          node.scaleX(1);
                          node.scaleY(1);
                          update(annotation.id, {
                            x: node.x(),
                            y: node.y(),
                            width: Math.max(8, node.width() * scaleX),
                            height: Math.max(8, node.height() * scaleY),
                          });
                        }}
                      />
                    );
                  case "image":
                    return (
                      <ImageObject
                        key={annotation.id}
                        annotation={annotation}
                        captureImage={image}
                        sourceImage={
                          annotation.source.kind === "capture" &&
                          annotation.source.captureId &&
                          annotation.source.captureId !== meta.id
                            ? sourceImages.get(annotation.source.captureId)
                            : undefined
                        }
                        pieceImage={
                          annotation.source.kind === "piece"
                            ? pieceImages.get(annotation.source.pieceId)
                            : undefined
                        }
                        externalImage={externalImages.get(annotation.id)}
                        draggable={draggableNow}
                        onChange={(patch) => update(annotation.id, patch)}
                      />
                    );
                  case "crop":
                    return (
                      <Rect
                        key={annotation.id}
                        id={annotation.id}
                        x={annotation.x}
                        y={annotation.y}
                        width={annotation.width}
                        height={annotation.height}
                        // Only visible while cropping; the rest of the time the
                        // crop is expressed by what the stage shows at all.
                        stroke={cropping ? "#ffffff" : undefined}
                        strokeWidth={cropping ? 1 / fitScale : 0}
                        // A shape with no fill has no hit area, so without this
                        // the crop box could be resized but never dragged.
                        fill={cropping ? "rgba(255,255,255,0.001)" : undefined}
                        listening={cropping}
                        draggable={cropping}
                        onDragEnd={(event) =>
                          update(annotation.id, { x: event.target.x(), y: event.target.y() })
                        }
                        onTransformEnd={(event) => {
                          const node = event.target;
                          const scaleX = node.scaleX();
                          const scaleY = node.scaleY();
                          node.scaleX(1);
                          node.scaleY(1);
                          update(annotation.id, {
                            x: node.x(),
                            y: node.y(),
                            width: Math.max(16, node.width() * scaleX),
                            height: Math.max(16, node.height() * scaleY),
                          });
                        }}
                      />
                    );
                  default:
                    return null;
                }
              })}
            </Layer>

            {/* Selection chrome and the in-progress shape, kept apart from the
                content so a single hide() gives us a clean export. */}
            <Layer ref={overlayLayerRef} x={-viewport.x} y={-viewport.y}>
              {/* In crop mode, dim everything that the crop would discard. */}
              {cropping && crop && (
                <>
                  <Rect
                    x={0}
                    y={0}
                    width={meta.width}
                    height={crop.y}
                    fill="rgba(0,0,0,0.55)"
                    listening={false}
                  />
                  <Rect
                    x={0}
                    y={crop.y + crop.height}
                    width={meta.width}
                    height={Math.max(0, meta.height - crop.y - crop.height)}
                    fill="rgba(0,0,0,0.55)"
                    listening={false}
                  />
                  <Rect
                    x={0}
                    y={crop.y}
                    width={crop.x}
                    height={crop.height}
                    fill="rgba(0,0,0,0.55)"
                    listening={false}
                  />
                  <Rect
                    x={crop.x + crop.width}
                    y={crop.y}
                    width={Math.max(0, meta.width - crop.x - crop.width)}
                    height={crop.height}
                    fill="rgba(0,0,0,0.55)"
                    listening={false}
                  />
                </>
              )}

              {/* The preview has to be the shape you are actually drawing. A
                  dashed bounding box for an arrow shows the wrong thing - you
                  cannot see which end the head lands on until you let go. */}
              {draft?.tool === "arrow" && (
                <Arrow
                  points={[draft.startX, draft.startY, draft.x, draft.y]}
                  stroke={ACCENT}
                  fill={ACCENT}
                  strokeWidth={strokeWidth}
                  pointerLength={strokeWidth * 3}
                  pointerWidth={strokeWidth * 3}
                  lineCap="round"
                  lineJoin="round"
                  opacity={0.85}
                  listening={false}
                />
              )}

              {draft && draft.tool === "marquee" && (
                <Rect
                  {...draftBounds(draft)}
                  fill="rgba(59,130,246,0.15)"
                  stroke="#3b82f6"
                  strokeWidth={1 / fitScale}
                  listening={false}
                />
              )}

              {draft?.tool === "ellipse" && (
                <Ellipse
                  x={draftBounds(draft).x + draftBounds(draft).width / 2}
                  y={draftBounds(draft).y + draftBounds(draft).height / 2}
                  radiusX={draftBounds(draft).width / 2}
                  radiusY={draftBounds(draft).height / 2}
                  stroke={ACCENT}
                  strokeWidth={strokeWidth / 2}
                  dash={[6 * unit, 4 * unit]}
                  listening={false}
                />
              )}

              {draft && ["rect", "blur", "crop", "cut", "ocr"].includes(draft.tool) && (
                <Rect
                  {...draftBounds(draft)}
                  stroke={ACCENT}
                  strokeWidth={strokeWidth / 2}
                  dash={[6 * unit, 4 * unit]}
                  listening={false}
                />
              )}

              <Transformer
                ref={transformerRef}
                rotateEnabled={false}
                borderStroke={cropping ? "#ffffff" : ACCENT}
                anchorStroke={cropping ? "#ffffff" : ACCENT}
                anchorSize={8}
                ignoreStroke
                boundBoxFunc={(oldBox, newBox) =>
                  newBox.width < 16 || newBox.height < 16 ? oldBox : newBox
                }
              />
            </Layer>
          </Stage>

          {/* Text editing happens in a real textarea overlaid on the canvas -
              Konva has no text input of its own. */}
          {editing?.type === "text" && (
            <textarea
              className="text-editor"
              autoFocus
              defaultValue={editing.text}
              style={{
                left: (editing.x - viewport.x) * fitScale,
                top: (editing.y - viewport.y) * fitScale,
                fontSize: editing.fontSize * unit * fitScale,
                color: editing.fill,
              }}
              onBlur={(event) => {
                update(editing.id, { text: event.target.value || "Text" });
                setEditingId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
                // Enter commits; Shift+Enter inserts a newline.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          )}
        </div>
      </div>

      {foundText && (
        <TextResultDialog
          lines={foundText}
          onCopy={(text) => writeText(text)}
          onClose={() => setFoundText(null)}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
            {menuDeletable && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  copySelection(menu.targetId ? [menu.targetId, ...selectedIds] : selectedIds);
                  setMenu(null);
                }}
              >
                <CopyIcon />
                <span>
                  {selectedIds.length > 1 ? `Copy ${selectedIds.length} objects` : "Copy"}
                </span>
              </button>
            )}

            {/* Always offered: even with nothing copied in-app, the system
                clipboard may hold an image from another capture or another app. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                paste({ x: menu.imageX, y: menu.imageY });
                setMenu(null);
              }}
            >
              <PasteIcon />
              <span>Paste here</span>
            </button>

            <div className="context-separator" role="separator" />

            <button type="button" role="menuitem" onClick={() => runAndClose(onCopy)}>
              <ImageIcon />
              <span>Copy whole image</span>
            </button>
            <button type="button" role="menuitem" onClick={() => runAndClose(onSave)}>
              <DownloadIcon />
              <span>Save PNG...</span>
            </button>

            {/* Destructive action last, behind a separator, so it is never where
                "Save" just was. */}
            {menuDeletable && (
              <>
                <div className="context-separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    remove(menu.targetId ? [menu.targetId, ...selectedIds] : selectedIds);
                    setMenu(null);
                  }}
                >
                  <TrashIcon />
                  <span>
                    {selectedIds.length > 1 ? `Delete ${selectedIds.length} objects` : "Delete"}
                  </span>
                </button>
              </>
            )}
        </ContextMenu>
      )}

    </div>
  );
}
