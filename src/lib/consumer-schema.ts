// WHAT A VALID CONSUMER LISTING IS, in one place.
//
// Two routes write these rows now: the public submit form (/api/consumers) and the admin editor
// (/api/admin/consumers). They were one route when these rules were written as locals inside it, and
// leaving them there would have meant the admin could save a logo URL the public form rejects, or a
// blurb the content filter would have refused. The looser of two validators is the one that decides
// what ends up in the database, so there is only one.
//
// SERVER ONLY, deliberately not folded into lib/consumers.ts: that module is imported by the
// /powered-by client page, and these pull in zod and the content filter behind them.

import { z } from "zod";
import { isClean } from "./content-filter";
import { CONSUMER_CATEGORIES } from "./consumers";

const CLEAN = "contains inappropriate language; please revise";

// Only http(s) URLs, and reject anything with credentials or that isn't a real absolute URL.
export const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be a valid http(s) URL");

// A logo URL must point at an image file, not a web page. We can't fetch it to check content-type at
// submit time, so require the path to end in a known image extension (query string/# allowed). This
// rejects the common mistake of pasting the site homepage (e.g. https://example.com/) into the field.
export const imageUrl = httpUrl.refine((s) => {
  try {
    return /\.(png|jpe?g|svg|webp|gif|avif)$/i.test(new URL(s).pathname);
  } catch {
    return false;
  }
}, "logo must be a direct link to an image (.png, .jpg, .svg, .webp, .gif, .avif)");

/** The editable fields of a listing, shared by the public submit form and the admin editor. */
export const consumerFields = {
  name: z.string().trim().min(1).max(80).refine(isClean, CLEAN),
  url: httpUrl,
  category: z.enum(CONSUMER_CATEGORIES),
  blurb: z.string().trim().min(1).max(1000).refine(isClean, CLEAN),
  // Optional external https logo IMAGE URL (must end in an image extension). No git-CDN upload for
  // consumers in v1.
  logoURL: imageUrl.optional().or(z.literal("")),
  // Optional private contact for follow-up; never shown publicly.
  contactEmail: z.string().trim().email().max(160).optional().or(z.literal("")),
};

/** Moderation states. Only "approved" is visible on /powered-by. */
export const CONSUMER_STATUSES = ["pending", "approved", "rejected"] as const;
export type ConsumerStatus = (typeof CONSUMER_STATUSES)[number];
