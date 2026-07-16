// Shared helpers for the "Powered by Flare Registry" consumer directory (the third-party products that
// USE the feed, showcased on /powered-by). Consumers are wallet-less and moderated; see the Consumer
// model in prisma/schema.prisma.

import type { Consumer } from "@prisma/client";

// Allowed categories for a consumer listing. Kept in one place so the form, the server validation and
// the showcase grouping agree.
export const CONSUMER_CATEGORIES = [
  "wallet",
  "explorer",
  "dapp",
  "analytics",
  "tooling",
  "other",
] as const;

export type ConsumerCategory = (typeof CONSUMER_CATEGORIES)[number];

export function isConsumerCategory(v: unknown): v is ConsumerCategory {
  return typeof v === "string" && (CONSUMER_CATEGORIES as readonly string[]).includes(v);
}

// The public shape of an approved consumer, safe to send to the browser: no contactEmail, no
// moderation internals. Used by the showcase page and the edit-mode dropdown.
export interface PublicConsumer {
  id: string;
  name: string;
  url: string;
  category: string;
  blurb: string;
  logoURL: string | null;
}

export function toPublicConsumer(c: Consumer): PublicConsumer {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    category: c.category,
    blurb: c.blurb,
    logoURL: c.logoURL ?? null,
  };
}
