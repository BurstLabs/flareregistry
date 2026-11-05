// The logo rules, for the SCRIPTS that mirror images from elsewhere.
//
// src/lib/logo-normalise.ts is the canonical implementation and runs on every upload. Mirrored
// logos never passed through it, which is how the assets we serve came to include ten non-square
// images, a 512x512 and a 120x120: mirror scripts wrote the source bytes verbatim. Keep the two in
// sync; they encode the same four rules (square, 128-256px, <=24KB, never upscale past the source).
//
// Alpha is recommended, not required: an image that is already square, in range and small enough is
// returned untouched even when fully opaque, because re-encoding it through palette quantisation to
// add a channel nobody can see risks the artwork for nothing.
import sharp from "sharp";

export const LOGO_MAX_BYTES = 24 * 1024;
export const LOGO_MIN_DIM = 128;
export const LOGO_MAX_DIM = 256;

/** @returns {Promise<{buf: Buffer, converted: boolean, note?: string} | {error: string}>} */
export async function normalisePng(input) {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return { error: "could not read that image" };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return { error: "could not read that image's dimensions" };

  if (
    meta.format === "png" &&
    w === h &&
    w >= LOGO_MIN_DIM &&
    w <= LOGO_MAX_DIM &&
    input.length <= LOGO_MAX_BYTES
  ) {
    return { buf: input, converted: false };
  }

  // Largest allowed square that does not upscale the source, floored at the minimum. Letterboxed
  // onto transparency rather than cropped: cutting content off someone's mark is worse than padding.
  const side = Math.max(LOGO_MIN_DIM, Math.min(LOGO_MAX_DIM, Math.max(w, h)));
  const base = sharp(input)
    .resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha();

  for (const colours of [256, 128, 64, 32, 16]) {
    const out = await base.clone().png({ compressionLevel: 9, palette: true, colours, effort: 10 }).toBuffer();
    if (out.length <= LOGO_MAX_BYTES) {
      return { buf: out, converted: true, note: `${side}x${side}${colours < 256 ? ` (${colours} colours)` : ""}` };
    }
  }
  return { error: "could not compress under 24KB at the smallest allowed size" };
}
