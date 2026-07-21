import { useEffect, useState } from "react";

import { readCaptureThumbnail } from "../lib/ipc";

/**
 * One history thumbnail, fetched only once the strip says it is near the view.
 *
 * Every thumbnail used to be read the moment the app opened - one IPC call, one
 * blob and one object URL per capture, whether or not you ever scrolled to it,
 * and each arrival re-rendered the whole strip. Loading on demand makes the cost
 * proportional to what is on screen rather than to how long the history is.
 *
 * Visibility is decided by the parent rather than by an `IntersectionObserver`
 * here: one scroll listener for the strip beats one observer per row, and it
 * behaves the same everywhere. (Observers were tried first and turned out to be
 * silent in some environments, which would have left the history blank.)
 */
interface Props {
  id: string;
  /** True once this row has come near the viewport. Never goes back to false. */
  load: boolean;
}

export default function GalleryThumb({ id, load }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!load) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const blob = await readCaptureThumbnail(id);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (error) {
        console.error("thumbnail load failed", id, error);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      // The element owns its URL, so it is released exactly when the row goes.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, load]);

  if (url) return <img className="thumb" src={url} alt="" draggable={false} />;
  return <div className={failed ? "thumb-placeholder failed" : "thumb-placeholder"} />;
}
