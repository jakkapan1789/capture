/** Typed wrappers around the Rust commands. The only place `invoke` is called. */

import { invoke } from "@tauri-apps/api/core";
import { livePieceIds, type Annotation } from "./types";

export interface CaptureMeta {
  id: string;
  createdAt: number;
  /** Physical pixel size of the stored PNG. */
  width: number;
  height: number;
  scaleFactor: number;
  originX: number;
  originY: number;
}

export interface GalleryItem {
  meta: CaptureMeta;
  annotations: Annotation[];
}

export interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsView {
  captureRegionHotkey: string | null;
  /** False when a hotkey is set but the OS refused it (another app owns it). */
  hotkeyRegistered: boolean;
  defaultHotkey: string;
  /** Copy every new capture to the clipboard the moment it is taken. */
  autoCopyToClipboard: boolean;
}

/**
 * A partial settings update. Omitted fields are left alone, so changing one
 * preference cannot clobber another.
 */
export interface PreferencesPatch {
  autoCopyToClipboard?: boolean;
}

export const CAPTURE_CREATED = "capture://created";
/** Raised when macOS refuses screen capture. */
export const PERMISSION_DENIED = "capture://permission-denied";
/** Error string the capture commands return in that case. */
export const PERMISSION_DENIED_ERROR = "screen-recording-permission-denied";

/** Raised by the macOS menu's "About Capture" item. */
export const MENU_ABOUT = "menu://about";

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
  storageDir: string;
}

export const appInfo = () => invoke<AppInfo>("app_info");

/** Absolute path of a capture's PNG, for revealing it in the file manager. */
export const captureFilePath = (id: string) =>
  invoke<string>("capture_file_path", { id });

export const getSettings = () => invoke<SettingsView>("get_settings");

/** Pass `null` to switch the hotkey off entirely. */
export const setCaptureHotkey = (hotkeyAccelerator: string | null) =>
  invoke<SettingsView>("set_capture_hotkey", { hotkeyAccelerator });

/** Change preferences that cannot fail. The hotkey has its own command. */
export const updatePreferences = (patch: PreferencesPatch) =>
  invoke<SettingsView>("update_preferences", { patch });

export interface RecognizedLine {
  text: string;
  /** 0-1, as reported by the OS engine. Low-confidence lines are already gone. */
  confidence: number;
}

export const textRecognitionAvailable = () =>
  invoke<boolean>("text_recognition_available");

/** Read text from a PNG. Lines arrive in reading order, already filtered. */
export const recognizeText = async (png: Blob) =>
  invoke<RecognizedLine[]>("recognize_text", {
    png: Array.from(new Uint8Array(await png.arrayBuffer())),
  });

export const listMonitors = () => invoke<MonitorInfo[]>("list_monitors");
export const screenPermissionGranted = () =>
  invoke<boolean>("screen_permission_granted");
export const openRegionOverlay = () => invoke<void>("open_region_overlay");
export const closeRegionOverlay = () => invoke<void>("close_region_overlay");

/** `region` is in logical pixels relative to the calling window. */
export const captureRegion = (region: Region) =>
  invoke<CaptureMeta>("capture_region", { region });

export const captureMonitor = (monitorId: number) =>
  invoke<CaptureMeta>("capture_monitor", { monitorId });

export const listGallery = () => invoke<CaptureMeta[]>("list_gallery");
export const loadGalleryItem = (id: string) =>
  invoke<GalleryItem>("load_gallery_item", { id });
export const deleteGalleryItem = (id: string) =>
  invoke<void>("delete_gallery_item", { id });

/** Bulk delete; returns how many were removed. */
export const deleteGalleryItems = (ids: string[]) =>
  invoke<number>("delete_gallery_items", { ids });

export const saveAnnotations = (id: string, annotations: Annotation[]) =>
  invoke<void>("save_annotations", {
    id,
    annotations,
    // Anything not named here is deleted, so this must be derived from the same
    // list being written - never from a stale copy.
    pieces: livePieceIds(annotations),
  });

/** Store a cut-out's flattened pixels beside its capture. */
export const saveCapturePiece = async (id: string, pieceId: string, png: Blob) =>
  invoke<void>("save_capture_piece", {
    id,
    pieceId,
    png: Array.from(new Uint8Array(await png.arrayBuffer())),
  });

/**
 * These commands return raw bytes via `tauri::ipc::Response`, which arrives as an
 * ArrayBuffer rather than a JSON array of numbers - a meaningful difference for a
 * multi-megabyte screenshot.
 */
async function readBytes(command: string, id: string): Promise<Blob> {
  const data = await invoke<ArrayBuffer | number[]>(command, { id });
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  return new Blob([bytes], { type: imageMime(bytes) });
}

/**
 * Label a blob by what it actually contains.
 *
 * Thumbnails are JPEG now but captures saved earlier still have PNG ones, and
 * both arrive through the same command - so the type has to come from the bytes
 * rather than from which call was made.
 */
function imageMime(bytes: Uint8Array): string {
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
}

/** Make a small capture readable: creates a new, upscaled + sharpened capture. */
export const enhanceCapture = (id: string) =>
  invoke<CaptureMeta>("enhance_capture", { id });

export const readCaptureImage = (id: string) =>
  readBytes("read_capture_image", id);
export const readCaptureThumbnail = (id: string) =>
  readBytes("read_capture_thumbnail", id);

export async function readCapturePiece(id: string, pieceId: string): Promise<Blob> {
  const data = await invoke<ArrayBuffer | number[]>("read_capture_piece", { id, pieceId });
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  return new Blob([bytes], { type: imageMime(bytes) });
}
