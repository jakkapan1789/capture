/** Helpers for getting pasted pixels onto the canvas. */

import { readImage } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Konva accepts a canvas directly as an image source, which lets clipboard data
 * skip a PNG encode/decode round trip entirely.
 */
export type PastedImage = { source: CanvasImageSource; width: number; height: number };

/**
 * Read an image off the system clipboard.
 *
 * Returns null when the clipboard holds no image - the common case when someone
 * presses Cmd+V having copied text, which should be a no-op rather than an error.
 */
export async function readClipboardImage(): Promise<PastedImage | null> {
  let rgba: Uint8Array;
  let size: { width: number; height: number };

  try {
    const image = await readImage();
    rgba = await image.rgba();
    size = await image.size();
  } catch {
    // The plugin throws rather than returning empty when the clipboard holds
    // something that isn't an image.
    return null;
  }

  if (size.width === 0 || size.height === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), size.width, size.height),
    0,
    0,
  );

  return { source: canvas, width: size.width, height: size.height };
}

/**
 * Place a pasted image sensibly.
 *
 * Scaled down to fit with a margin, never scaled up past its natural size. With
 * `at`, the image is anchored at that point (right-click "Paste here") and then
 * nudged back inside the viewport so it can never land mostly off-canvas;
 * without it, the image is centred.
 */
export function placeInViewport(
  pasted: PastedImage,
  viewport: { x: number; y: number; width: number; height: number },
  at?: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  const fit = Math.min(
    (viewport.width * 0.8) / pasted.width,
    (viewport.height * 0.8) / pasted.height,
    1,
  );
  const width = Math.round(pasted.width * fit);
  const height = Math.round(pasted.height * fit);

  if (!at) {
    return {
      x: Math.round(viewport.x + (viewport.width - width) / 2),
      y: Math.round(viewport.y + (viewport.height - height) / 2),
      width,
      height,
    };
  }

  const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

  return {
    x: clamp(at.x, viewport.x, viewport.x + viewport.width - width),
    y: clamp(at.y, viewport.y, viewport.y + viewport.height - height),
    width,
    height,
  };
}
