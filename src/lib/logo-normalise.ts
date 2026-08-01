// Turn whatever a user uploaded into a logo that satisfies the provider-list requirements.
//
// The requirements (square, 128-256px, alpha channel, <=24KB PNG) are met by essentially no image a
// phone can produce. iOS ignores accept="image/png" when picking from Photos, anything from the photo
// library arrives as JPEG, and a screenshot is a 1170x2532 PNG far over the size limit. The only path
// that worked was Files, holding an already-compliant asset made on a desktop.
//
// sharp is already a dependency and was being used ONLY to validate. Using it to convert as well is
// what makes the flow usable, and it costs nothing extra.
//
// Deliberately conservative: we letterbox onto a transparent square rather than cropping, because
// silently cutting content off someone's logo is worse than padding it. We never upscale past the
// source, so a small image stays crisp rather than being blurred up to 256.
import sharp from "sharp";
import { LOGO_MAX_BYTES, LOGO_MIN_DIM, LOGO_MAX_DIM } from "./png";

export interface NormaliseResult {
  buf: Buffer;
  /** True when we changed the image, so the caller can tell the user what happened. */
  converted: boolean;
  note?: string;
}

export async function normaliseLogo(input: Buffer): Promise<NormaliseResult | { error: string }> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return { error: "could not read that image" };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return { error: "could not read that image's dimensions" };

  // Already compliant PNG: leave it exactly as uploaded rather than re-encoding it.
  const alreadyOk =
    meta.format === "png" &&
    w === h &&
    w >= LOGO_MIN_DIM &&
    w <= LOGO_MAX_DIM &&
    meta.hasAlpha &&
    input.length <= LOGO_MAX_BYTES;
  if (alreadyOk) return { buf: input, converted: false };

  // Target the largest allowed square that does not upscale the source, floored at the minimum.
  const longest = Math.max(w, h);
  const side = Math.max(LOGO_MIN_DIM, Math.min(LOGO_MAX_DIM, longest));

  const base = sharp(input)
    .resize(side, side, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: false,
    })
    .ensureAlpha();

  // Step compression down until it fits. PNG has no quality dial, so reduce the palette instead,
  // which is what actually moves the needle for flat logo artwork.
  for (const colours of [256, 128, 64, 32, 16]) {
    const out = await base
      .clone()
      .png({ compressionLevel: 9, palette: true, colours, effort: 10 })
      .toBuffer();
    if (out.length <= LOGO_MAX_BYTES) {
      return {
        buf: out,
        converted: true,
        note: `converted to a ${side}x${side} PNG${colours < 256 ? ` (${colours}-colour palette)` : ""}`,
      };
    }
  }
  // Last resort: a smaller square still inside the allowed range.
  const small = await sharp(input)
    .resize(LOGO_MIN_DIM, LOGO_MIN_DIM, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png({ compressionLevel: 9, palette: true, colours: 16, effort: 10 })
    .toBuffer();
  if (small.length <= LOGO_MAX_BYTES) {
    return { buf: small, converted: true, note: `converted to a ${LOGO_MIN_DIM}x${LOGO_MIN_DIM} PNG` };
  }
  return {
    error:
      "that image could not be compressed under 24KB even at the smallest allowed size; try a simpler graphic",
  };
}
