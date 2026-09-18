// Real transparency for generated images. Image models asked for a "transparent
// background" paint a grey checkerboard into an opaque JPEG. So the server asks
// for a plain white studio background instead and removes it here.
//
// The background is flooded in from the image edges, not matched by colour
// everywhere, so white highlights inside the subject stay.

import sharp from 'sharp';

// How far (largest channel difference) a pixel may be from the background colour
// and still count as background, and where the feathered rim becomes fully opaque.
const BACKGROUND_TOLERANCE = 30;
const OPAQUE_DISTANCE = 96;

export const WHITE_BACKGROUND_PROMPT =
  ' The subject is isolated on a plain, seamless, pure white (#FFFFFF) studio background that fills the whole frame. No shadow, no reflection, no checkerboard pattern, no border, no text.';

/** The words that make an image model draw a checkerboard come out of the prompt. */
export function promptForCutout(prompt: string): string {
  const cleaned = prompt
    .replace(/\b(?:on|with|against|over)\s+an?\s+(?:fully |completely |totally )?transparent background\b/gi, '')
    .replace(/\b(?:fully |completely |totally )?transparent(?: background)?\b/gi, '')
    .replace(/\bPNG\b|\balpha channel\b/gi, '')
    .replace(/\s+([.,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned + WHITE_BACKGROUND_PROMPT;
}

function distance(data: Uint8Array | Buffer, offset: number, background: [number, number, number]): number {
  return Math.max(
    Math.abs(data[offset] - background[0]),
    Math.abs(data[offset + 1] - background[1]),
    Math.abs(data[offset + 2] - background[2]),
  );
}

/**
 * Clears the background of an RGBA image in place. Returns the share of pixels
 * removed, so the caller can tell a clean cut-out from a picture that had no
 * plain background to remove.
 */
export function removeBackground(data: Uint8Array | Buffer, width: number, height: number): number {
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const background = [0, 1, 2].map((channel) =>
    Math.round(corners.reduce((sum, pixel) => sum + data[pixel * 4 + channel], 0) / corners.length),
  ) as [number, number, number];

  const removed = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const visit = (pixel: number) => {
    if (removed[pixel] || distance(data, pixel * 4, background) > BACKGROUND_TOLERANCE) return;
    removed[pixel] = 1;
    queue[tail++] = pixel;
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < width * (height - 1)) visit(pixel + width);
  }

  for (let pixel = 0; pixel < width * height; pixel++) {
    if (removed[pixel]) {
      data[pixel * 4 + 3] = 0;
      continue;
    }
    // Feather the rim: a kept pixel that touches the background fades with how
    // close its colour is to it, which takes the white fringe off the outline.
    const x = pixel % width;
    const touches =
      (x > 0 && removed[pixel - 1]) ||
      (x < width - 1 && removed[pixel + 1]) ||
      (pixel >= width && removed[pixel - width]) ||
      (pixel < width * (height - 1) && removed[pixel + width]);
    if (!touches) continue;
    const share = (distance(data, pixel * 4, background) - BACKGROUND_TOLERANCE) / (OPAQUE_DISTANCE - BACKGROUND_TOLERANCE);
    data[pixel * 4 + 3] = Math.round(data[pixel * 4 + 3] * Math.min(1, Math.max(0.15, share)));
  }
  return tail / (width * height);
}

/** Returns a PNG with the background cut out, or null when there was no plain background to cut. */
export async function cutOutBackground(image: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const share = removeBackground(data, info.width, info.height);
  // Almost nothing removed: the model ignored the white background. Almost
  // everything removed: the subject went with it. Either way keep the original.
  if (share < 0.05 || share > 0.97) return null;
  // Crop to the subject, with a little air, so the empty frame does not pad the page.
  const margin = Math.round(Math.max(info.width, info.height) * 0.02);
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const cropped = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ background: clear, threshold: 1 })
    .png()
    .toBuffer();
  return sharp(cropped).extend({ top: margin, bottom: margin, left: margin, right: margin, background: clear }).png().toBuffer();
}
