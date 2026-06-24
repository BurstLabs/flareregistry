"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/providers";

// FAQ entries are keyed in i18n (faq.qN / faq.aN). Answers may contain link tokens like
// [submit], [governance], [api], [why] which are rendered as internal links below.
const ENTRIES = [
  "list",
  "qualified",
  "notQualified",
  "loseQualified",
  "registered",
  "mgBadge",
  "flagged",
  "addresses",
  "api",
  "cost",
  "who",
] as const;

const LINKS: Record<string, { href: string; labelKey: string }> = {
  submit: { href: "/submit", labelKey: "nav.list" },
  governance: { href: "/governance", labelKey: "nav.governance" },
  api: { href: "/api", labelKey: "nav.api" },
  why: { href: "/why", labelKey: "nav.why" },
  directory: { href: "/", labelKey: "nav.directory" },
  contact: { href: "/contact", labelKey: "footer.contact" },
};

// Render an answer string, turning [token] into an internal link.
function Answer({ text, t }: { text: string; t: (k: string) => string }) {
  const parts = text.split(/(\[[a-z]+\])/g);
  return (
    <p className="mt-2 text-sm leading-relaxed text-muted">
      {parts.map((part, i) => {
        const m = part.match(/^\[([a-z]+)\]$/);
        if (m && LINKS[m[1]]) {
          const { href, labelKey } = LINKS[m[1]];
          return (
            <Link key={i} href={href} className="text-beacon hover:underline">
              {t(labelKey)}
            </Link>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </p>
  );
}

function Item({ id, t }: { id: string; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-themed py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 text-left font-medium hover:text-beacon"
      >
        <span>{t(`faq.q.${id}`)}</span>
        <span className="shrink-0 text-faint">{open ? "−" : "+"}</span>
      </button>
      {open && <Answer text={t(`faq.a.${id}`)} t={t} />}
    </div>
  );
}

export default function FaqPage() {
  const { t } = useApp();
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t("faq.title")}</h1>
      <p className="mt-3 leading-relaxed text-muted">{t("faq.intro")}</p>
      <div className="mt-6">
        {ENTRIES.map((id) => (
          <Item key={id} id={id} t={t} />
        ))}
      </div>
      <p className="mt-8 text-sm text-muted">
        {t("faq.more")}{" "}
        <Link href="/contact" className="text-beacon hover:underline">
          {t("footer.contact")}
        </Link>
        .
      </p>
    </div>
  );
}
