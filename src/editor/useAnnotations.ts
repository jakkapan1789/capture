import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Annotation } from "../lib/types";

/** Undo steps kept. Each is a list of small plain objects, so this is cheap. */
const MAX_HISTORY = 100;

interface HistoryState {
  annotations: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
}

type Action =
  | { type: "load"; annotations: Annotation[] }
  | { type: "apply"; transform: (list: Annotation[]) => Annotation[]; checkpoint: boolean }
  | { type: "undo" }
  | { type: "redo" };

/**
 * Pure so React can safely call it twice in StrictMode.
 *
 * History is whole-list snapshots rather than diffs. Captures hold tens of
 * annotations, not thousands, so the simplicity is worth more than the bytes.
 */
function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case "load":
      return { annotations: action.annotations, past: [], future: [] };

    case "apply": {
      const annotations = action.transform(state.annotations);
      // A no-op edit (dragging a shape one pixel and back, a rejected reorder)
      // must not consume an undo step.
      if (annotations === state.annotations) return state;
      return {
        annotations,
        past: action.checkpoint
          ? [...state.past, state.annotations].slice(-MAX_HISTORY)
          : state.past,
        future: action.checkpoint ? [] : state.future,
      };
    }

    case "undo": {
      if (state.past.length === 0) return state;
      return {
        annotations: state.past[state.past.length - 1],
        past: state.past.slice(0, -1),
        future: [state.annotations, ...state.future].slice(0, MAX_HISTORY),
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        annotations: next,
        past: [...state.past, state.annotations].slice(-MAX_HISTORY),
        future: rest,
      };
    }
  }
}

/**
 * Annotation list state, with undo/redo.
 *
 * Array order is meaningful twice over: it is the z-order, and for step badges it
 * is also the numbering. Everything here preserves it deliberately.
 */
export function useAnnotations() {
  const [state, dispatch] = useReducer(reducer, {
    annotations: [],
    past: [],
    future: [],
  });
  const { annotations } = state;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  /**
   * Whether the user has actually edited anything since the capture was loaded.
   *
   * Persistence keys off this rather than off "annotations changed", so merely
   * opening a capture never rewrites its JSON - which also means a re-render
   * before the initial load has applied can't blank out stored annotations.
   */
  const dirty = useRef(false);

  /**
   * True once a checkpoint has been taken for the gesture in progress.
   *
   * A single user action calls `update` many times - dragging a multi-selection
   * moves every follower, and picking a colour recolours the whole selection.
   * Everything one event handler does runs in a single microtask, so clearing the
   * flag in a microtask makes one gesture cost exactly one undo step.
   */
  const gestureOpen = useRef(false);

  const shouldCheckpoint = () => {
    if (gestureOpen.current) return false;
    gestureOpen.current = true;
    queueMicrotask(() => {
      gestureOpen.current = false;
    });
    return true;
  };

  const mutate = useCallback((transform: (list: Annotation[]) => Annotation[]) => {
    dirty.current = true;
    dispatch({ type: "apply", transform, checkpoint: shouldCheckpoint() });
  }, []);

  const load = useCallback((next: Annotation[]) => {
    dispatch({ type: "load", annotations: next });
    setSelectedIds([]);
    dirty.current = false;
  }, []);

  const add = useCallback(
    (annotation: Annotation) => {
      mutate((previous) => [...previous, annotation]);
      setSelectedIds([annotation.id]);
    },
    [mutate],
  );

  const update = useCallback(
    (id: string, patch: Partial<Annotation>) => {
      mutate((previous) =>
        previous.map((annotation) =>
          annotation.id === id ? ({ ...annotation, ...patch } as Annotation) : annotation,
        ),
      );
    },
    [mutate],
  );

  const remove = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const doomed = new Set(ids);
      mutate((previous) => previous.filter((annotation) => !doomed.has(annotation.id)));
    },
    [mutate],
  );

  /** Replace the whole list, e.g. when a crop supersedes the previous one. */
  const replaceAll = useCallback(
    (next: Annotation[]) => {
      mutate(() => next);
    },
    [mutate],
  );

  /** Shift-click and marquee-with-shift extend the selection instead of replacing it. */
  const select = useCallback((id: string, additive: boolean) => {
    setSelectedIds((previous) => {
      if (!additive) return previous.includes(id) ? previous : [id];
      return previous.includes(id)
        ? previous.filter((existing) => existing !== id)
        : [...previous, id];
    });
  }, []);

  /**
   * Move a step badge one place earlier or later in the numbering.
   *
   * Swaps the two badges' slots in the annotation array; because the displayed
   * number is derived from that order, the digits swap with them.
   */
  const reorderStep = useCallback(
    (id: string, delta: -1 | 1) => {
      mutate((previous) => {
        const stepIndices = previous.reduce<number[]>((indices, annotation, index) => {
          if (annotation.type === "step") indices.push(index);
          return indices;
        }, []);

        const position = stepIndices.findIndex((index) => previous[index].id === id);
        const target = position + delta;
        // Returning the same array tells the reducer nothing happened, so a
        // reorder off the end of the list does not burn an undo step.
        if (position === -1 || target < 0 || target >= stepIndices.length) return previous;

        const next = [...previous];
        const [from, to] = [stepIndices[position], stepIndices[target]];
        [next[from], next[to]] = [next[to], next[from]];
        return next;
      });
    },
    [mutate],
  );

  const undo = useCallback(() => {
    dirty.current = true;
    dispatch({ type: "undo" });
  }, []);

  const redo = useCallback(() => {
    dirty.current = true;
    dispatch({ type: "redo" });
  }, []);

  // Undoing past a shape's creation leaves its id selected but gone. Prune
  // rather than clearing, so undoing an unrelated edit keeps your selection.
  useEffect(() => {
    setSelectedIds((previous) => {
      const alive = previous.filter((id) =>
        annotations.some((annotation) => annotation.id === id),
      );
      return alive.length === previous.length ? previous : alive;
    });
  }, [annotations]);

  return {
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
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
