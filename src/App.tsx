import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

/**
 * The editor is loaded on demand, and with it Konva.
 *
 * Konva is 324KB of a 573KB bundle, and nothing on screen needs it until a
 * capture is opened - the app starts with nothing open, and the region-selection
 * overlay, which runs the same bundle in its own window, never uses it at all.
 * Loading it eagerly meant every cold start and every press of the capture
 * hotkey parsed it first.
 */
const Editor = lazy(() => import("./editor/Editor"));
import DeleteCapturesDialog from "./gallery/DeleteCapturesDialog";
import GalleryStrip from "./gallery/GalleryStrip";
import AboutDialog from "./about/AboutDialog";
import PermissionDialog from "./PermissionDialog";
import CaptureActions from "./CaptureActions";
import {
  CAPTURE_CREATED,
  MENU_ABOUT,
  PERMISSION_DENIED,
  PERMISSION_DENIED_ERROR,
  captureMonitor,
  deleteGalleryItem,
  deleteGalleryItems,
  listGallery,
  listMonitors,
  loadGalleryItem,
  openRegionOverlay,
  openScrollOverlay,
  captureFilePath,
  getSettings,
  readCaptureImage,
  type CaptureMeta,
  type SettingsView,
} from "./lib/ipc";
import { loadImageFromBlob } from "./lib/images";
import type { Annotation } from "./lib/types";
import RegionOverlay from "./overlay/RegionOverlay";
import ScrollPanel from "./scroll/ScrollPanel";
import SettingsDialog from "./settings/SettingsDialog";

/** Both windows load the same bundle; the label decides which app they get. */
const OVERLAY_LABEL = "region-overlay";
const SCROLL_PANEL_LABEL = "scroll-control";

/**
 * Objects copied with Copy / Cmd+C.
 *
 * Lives here rather than in the editor because the editor is remounted for every
 * capture - keeping it there meant copying something and then switching pictures
 * silently emptied the clipboard, which is exactly when you most want to paste.
 */
export interface ObjectClipboard {
  annotations: Annotation[];
  /** Pixels for any session-only images among them, keyed by their id. */
  images: Map<string, CanvasImageSource>;
}

interface OpenCapture {
  meta: CaptureMeta;
  image: HTMLImageElement;
  annotations: Annotation[];
}

function CaptureApp() {
  const [items, setItems] = useState<CaptureMeta[]>([]);
  const [open, setOpen] = useState<OpenCapture | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cleanUpOpen, setCleanUpOpen] = useState(false);
  /**
   * Whether About is open, and whether Settings is waiting behind it.
   *
   * Reached from Settings it should hand back to Settings; reached from the
   * application menu there is nothing behind it, and the dialog offers Close
   * instead of a Back button that would open something the user never opened.
   */
  const [about, setAbout] = useState<null | "standalone" | "from-settings">(null);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [clipboard, setClipboard] = useState<ObjectClipboard>({
    annotations: [],
    images: new Map(),
  });
  /**
   * The capture being loaded, highlighted immediately on click.
   *
   * Without this the history item only lights up once the PNG has been read,
   * decoded and drawn, so a click feels like it did nothing for a moment.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);

  /**
   * Preferences, mirrored here because the capture path needs them.
   *
   * Held in a ref as well: the `capture://created` listener is registered once
   * and would otherwise capture the value that was current when it was set up,
   * so toggling auto-copy would not take effect until the next reload.
   */
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const settingsRef = useRef<SettingsView | null>(null);
  settingsRef.current = settings;

  useEffect(() => {
    void getSettings()
      .then(setSettings)
      .catch((error) => console.error("could not read settings", error));
  }, []);

  const flash = useCallback((message: string) => {
    setStatus(message);
    setTimeout(() => setStatus(null), 2600);
  }, []);

  const refresh = useCallback(async () => {
    setItems(await listGallery());
  }, []);

  const openCapture = useCallback(
    async (id: string) => {
      setPendingId(id);
      try {
        const [item, blob] = await Promise.all([loadGalleryItem(id), readCaptureImage(id)]);
        const image = await loadImageFromBlob(blob);
        setOpen({ meta: item.meta, image, annotations: item.annotations ?? [] });
      } catch (error) {
        console.error("could not open capture", error);
        flash(`Could not open capture: ${error}`);
      } finally {
        setPendingId(null);
      }
    },
    [flash],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Put a capture's original PNG on the clipboard.
   *
   * The original rather than a flattened render: at the moment a capture is
   * taken there is nothing annotated yet, and reading the file avoids waiting
   * for the editor to mount and rasterise.
   */
  const copyCaptureToClipboard = useCallback(
    async (id: string) => {
      try {
        const blob = await readCaptureImage(id);
        await writeImage(new Uint8Array(await blob.arrayBuffer()));
        return true;
      } catch (error) {
        console.error("auto-copy failed", error);
        return false;
      }
    },
    [],
  );

  // Rust announces a new capture once it is safely on disk.
  useEffect(() => {
    const unlisten = listen<CaptureMeta>(CAPTURE_CREATED, (event) => {
      void refresh();
      void openCapture(event.payload.id);

      if (settingsRef.current?.autoCopyToClipboard) {
        void copyCaptureToClipboard(event.payload.id).then((ok) =>
          flash(ok ? "Captured and copied to clipboard" : "Captured - copy to clipboard failed"),
        );
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [refresh, openCapture, copyCaptureToClipboard, flash]);

  // The macOS app menu's About item is the standard entry point; Windows has no
  // menu bar here, which is why Settings also links to it.
  useEffect(() => {
    const unlisten = listen(PERMISSION_DENIED, () => setPermissionOpen(true));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen(MENU_ABOUT, () => setAbout("standalone"));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  /** True when a failed capture was actually macOS refusing permission. */
  const handledPermission = useCallback((error: unknown) => {
    if (!String(error).includes(PERMISSION_DENIED_ERROR)) return false;
    setPermissionOpen(true);
    return true;
  }, []);

  const onCaptureRegion = async () => {
    try {
      await openRegionOverlay();
    } catch (error) {
      if (!handledPermission(error)) flash(`Could not start region capture: ${error}`);
    }
  };

  const onCaptureScreen = async () => {
    try {
      const monitors = await listMonitors();
      const target = monitors.find((monitor) => monitor.isPrimary) ?? monitors[0];
      if (!target) throw new Error("no monitors detected");
      await captureMonitor(target.id);
    } catch (error) {
      if (!handledPermission(error)) flash(`Capture failed: ${error}`);
    }
  };

  const onCaptureScrolling = async () => {
    try {
      await openScrollOverlay();
    } catch (error) {
      if (!handledPermission(error)) flash(`Could not start a scrolling capture: ${error}`);
    }
  };

  const onDelete = useCallback(
    async (id: string) => {
      await deleteGalleryItem(id);
      setOpen((current) => (current?.meta.id === id ? null : current));
      await refresh();
    },
    [refresh],
  );

  const onCopy = async (blob: Blob) => {
    try {
      await writeImage(new Uint8Array(await blob.arrayBuffer()));
      flash("Copied to clipboard");
    } catch (error) {
      flash(`Copy failed: ${error}`);
    }
  };

  const onSave = async (blob: Blob) => {
    try {
      const path = await save({
        title: "Export PNG",
        defaultPath: `${open?.meta.id ?? "capture"}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (!path) return;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      flash(`Saved to ${path}`);
    } catch (error) {
      flash(`Save failed: ${error}`);
    }
  };

  /**
   * Which capture is open, as a ref.
   *
   * Read inside `handleOpen` so that callback keeps a stable identity - putting
   * `open` in its dependencies would defeat memoising the history strip.
   */
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = open?.meta.id ?? null;

  // Stable identities keep the memoised history strip from re-rendering while
  // you annotate.
  const handleOpen = useCallback(
    (id: string) => {
      // Clicking the capture that is already open closes it. Unmounting the
      // editor is also what flushes any annotation edits still in its autosave
      // debounce, so nothing is lost on the way out.
      if (openIdRef.current === id) {
        setOpen(null);
        return;
      }
      void openCapture(id);
    },
    [openCapture],
  );
  const handleDelete = useCallback((id: string) => void onDelete(id), [onDelete]);
  const handleCleanUp = useCallback(() => setCleanUpOpen(true), []);

  /** Copy a capture's original PNG - no annotations - straight to the clipboard. */
  const handleCopyImage = useCallback(
    (id: string) => {
      void (async () => {
        try {
          const blob = await readCaptureImage(id);
          await writeImage(new Uint8Array(await blob.arrayBuffer()));
          flash("Copied to clipboard");
        } catch (error) {
          flash(`Copy failed: ${error}`);
        }
      })();
    },
    [flash],
  );

  const handleReveal = useCallback(
    (id: string) => {
      void (async () => {
        try {
          await revealItemInDir(await captureFilePath(id));
        } catch (error) {
          flash(`Could not show the file: ${error}`);
        }
      })();
    },
    [flash],
  );

  const deleteMany = useCallback(
    async (ids: string[]) => {
      try {
        await deleteGalleryItems(ids);
        // Close the editor if the capture it was showing is now gone.
        if (openIdRef.current && ids.includes(openIdRef.current)) setOpen(null);
        await refresh();
        flash(ids.length > 1 ? `Deleted ${ids.length} captures` : "Deleted 1 capture");
      } catch (error) {
        flash(`Delete failed: ${error}`);
      }
    },
    [refresh, flash],
  );

  const captureActions = (
    <CaptureActions
      onCaptureRegion={() => void onCaptureRegion()}
      onCaptureScreen={() => void onCaptureScreen()}
      onCaptureScrolling={() => void onCaptureScrolling()}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );

  return (
    <div className="app">

      <div className="app-body">
        <GalleryStrip
          items={items}
          activeId={pendingId ?? open?.meta.id ?? null}
          onOpen={handleOpen}
          onDelete={handleDelete}
          onCleanUp={handleCleanUp}
          onCopyImage={handleCopyImage}
          onRevealInFolder={handleReveal}
        />

        {open ? (
          <Suspense
            fallback={
              /* The same shell the editor renders, so opening a capture does not
                 flash an empty window while the chunk arrives. */
              <main className="editor">
                <div className="toolbar">
                  <div className="toolbar-spacer" />
                  {captureActions}
                </div>
                <div className="empty-state" />
              </main>
            }
          >
          <Editor
            key={open.meta.id}
            meta={open.meta}
            image={open.image}
            initialAnnotations={open.annotations}
            onCopy={onCopy}
            onSave={onSave}
            status={status}
            onNotify={flash}
            actions={captureActions}
            clipboard={clipboard}
            onClipboardChange={setClipboard}
          />
          </Suspense>
        ) : (
          <main className="editor">
            {/* Same single row as the editor's toolbar, so the capture buttons
                never move between the two states. */}
            <div className="toolbar">
              <div className="toolbar-spacer" />
              {status && <span className="status">{status}</span>}
              {captureActions}
            </div>
            <div className="empty-state">
              <h1>Nothing open</h1>
              <p>Take a capture, or pick one from the history on the left.</p>
            </div>
          </main>
        )}
      </div>

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={setSettings}
          onShowAbout={() => {
            setSettingsOpen(false);
            setAbout("from-settings");
          }}
        />
      )}

      {about && (
        <AboutDialog
          onClose={() => setAbout(null)}
          onBack={
            about === "from-settings"
              ? () => {
                  setAbout(null);
                  setSettingsOpen(true);
                }
              : undefined
          }
        />
      )}

      {permissionOpen && <PermissionDialog onClose={() => setPermissionOpen(false)} />}

      {cleanUpOpen && (
        <DeleteCapturesDialog
          items={items}
          onDelete={deleteMany}
          onClose={() => setCleanUpOpen(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  const label = getCurrentWindow().label;
  const isOverlay = label === OVERLAY_LABEL;
  const isScrollPanel = label === SCROLL_PANEL_LABEL;

  /**
   * Suppress the webview's own context menu everywhere.
   *
   * "Reload" and "Inspect Element" are developer affordances that make a desktop
   * app feel like a web page, and reloading would throw away unsaved annotations.
   * Text fields keep theirs, where cut/copy/paste is genuinely wanted; the app's
   * own right-click menus call `preventDefault` themselves and are unaffected.
   */
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    // The overlay window must not paint an opaque background over the screen.
    // Neither of the small windows may paint an opaque background over the
    // screen they are sitting on top of.
    document.body.classList.toggle("transparent", isOverlay || isScrollPanel);
  }, [isOverlay, isScrollPanel]);

  if (isOverlay) return <RegionOverlay />;
  if (isScrollPanel) return <ScrollPanel />;
  return <CaptureApp />;
}
