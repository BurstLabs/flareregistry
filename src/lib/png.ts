// PNG logo validation, enforcing the same requirements as the standard provider list:
//   - valid PNG
//   - square (aspect ratio 1)
//   - width and height between 128 and 256 px
//   - an alpha channel is RECOMMENDED, not required. The rule used to demand one, which this very
//     comment contradicted by allowing "a fully opaque image that fills the frame", and which 34
//     of the logos we already serve would fail, QuickNode's solid green mark among them. Bifrost's
//     own requirements say the same: transparency recommended, opaque valid. Enforcing it would
//     mean re-encoding those 34 through palette quantisation to add a channel that is opaque
//     everywhere, which risks the image to change nothing a viewer can see.
//   - max file size 24 KB (which also stands in for "must be optimized")
//
// "Content centered" is not machine-checkable reliably and is not enforced.

export const LOGO_MAX_BYTES = 24 * 1024; // 24 KB
export const LOGO_MIN_DIM = 128;
export const LOGO_MAX_DIM = 256;

export interface PngInfo {
  width: number;
  height: number;
  /** PNG color type from IHDR: 6 = RGBA, 2 = RGB, 3 = indexed, 4 = grayscale+alpha, 0 = gray. */
  colorType: number;
  hasAlpha: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Parse width/height/colorType from a PNG buffer, or null if it is not a valid PNG. */
export function parsePng(buf: Buffer): PngInfo | null {
  if (buf.length < 33) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIGNATURE[i]) return null;
  // The first chunk after the signature must be IHDR. Length(4) Type(4) at offset 8.
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf[25]; // bit depth at 24, color type at 25
  // Color types with an alpha channel: 4 (gray+alpha) and 6 (RGBA). Indexed (3) can carry
  // transparency via a tRNS chunk; treat it as alpha-capable too.
  const hasAlpha = colorType === 4 || colorType === 6 || colorType === 3;
  return { width, height, colorType, hasAlpha };
}

export interface LogoValidation {
  ok: boolean;
  error?: string;
}

/** Enforce the logo requirements against a file's bytes and declared size. */
export function validateLogo(buf: Buffer): LogoValidation {
  if (buf.length > LOGO_MAX_BYTES) {
    return { ok: false, error: `logo too large (max ${LOGO_MAX_BYTES / 1024} KB)` };
  }
  const info = parsePng(buf);
  if (!info) return { ok: false, error: "logo must be a PNG" };
  if (info.width !== info.height) {
    return { ok: false, error: "logo must be square (equal width and height)" };
  }
  if (
    info.width < LOGO_MIN_DIM ||
    info.width > LOGO_MAX_DIM ||
    info.height < LOGO_MIN_DIM ||
    info.height > LOGO_MAX_DIM
  ) {
    return {
      ok: false,
      error: `logo must be between ${LOGO_MIN_DIM} and ${LOGO_MAX_DIM} px on each side`,
    };
  }
  return { ok: true };
}

// True if the buffer has trailing bytes after the PNG IEND chunk. A valid PNG ends with the 12-byte
// IEND chunk (length 0 + "IEND" + CRC); anything after it is a polyglot/appended payload (S13).
function hasTrailingAfterIend(buf: Buffer): boolean {
  const idx = buf.lastIndexOf(Buffer.from("IEND", "ascii"));
  if (idx < 0) return true; // no IEND at all -> not a well-formed PNG
  // IEND chunk = [4-byte type at idx] + [4-byte CRC]; the chunk's last byte is at idx+3+4 = idx+7.
  const endOfPng = idx + 4 + 4;
  return buf.length > endOfPng;
}

/**
 * Full-decode logo validation (S13): runs the cheap header checks, rejects any bytes after IEND, then
 * actually decodes the image with sharp to confirm it is a real, non-truncated PNG and enforces the
 * decoded dimensions. Async because it decodes. Use this on upload.
 */
export async function validateLogoStrict(buf: Buffer): Promise<LogoValidation> {
  const basic = validateLogo(buf);
  if (!basic.ok) return basic;
  if (hasTrailingAfterIend(buf)) {
    return { ok: false, error: "logo has unexpected trailing data after the image" };
  }
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf, { failOn: "error" }).metadata();
    if (meta.format !== "png") return { ok: false, error: "logo must be a PNG" };
    if (
      meta.width == null ||
      meta.height == null ||
      meta.width !== meta.height ||
      meta.width < LOGO_MIN_DIM ||
      meta.width > LOGO_MAX_DIM
    ) {
      return { ok: false, error: "logo dimensions are invalid" };
    }
  } catch {
    return { ok: false, error: "logo is not a valid, decodable PNG" };
  }
  return { ok: true };
}
