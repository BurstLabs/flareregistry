"use client";

import Link from "next/link";
import { useApp } from "@/components/providers";

// Card bodies may contain a [governance] token that is rendered as an internal link.
const LINKS: Record<string, { href: string; labelKey: string }> = {
  governance: { href: "/governance", labelKey: "nav.governance" },
};

// Render a body string, turning [token] into an internal link.
function Body({ text, t }: { text: string; t: (k: string) => string }) {
  const parts = text.split(/(\[[a-z]+\])/g);
  return (
    <p className="mt-2 text-sm text-muted">
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

function Advantage({
  title,
  body,
  t,
}: {
  title: string;
  body: string;
  t: (k: string) => string;
}) {
  return (
    <div className="surface rounded-xl border p-5">
      <h3 className="font-semibold text-beacon">{title}</h3>
      <Body text={body} t={t} />
    </div>
  );
}

const CARDS = [
  "selfService",
  "ownership",
  "metrics",
  "qualification",
  "registeredOnly",
  "sticky",
  "managementGroup",
  "governance",
  "api",
  "logos",
  "openSource",
  "languages",
] as const;

export default function WhyPage() {
  const { t } = useApp();
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t("why.title")}</h1>
      <p className="mt-3 leading-relaxed text-muted">{t("why.intro")}</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {CARDS.map((id) => (
          <Advantage
            key={id}
            title={t(`why.card.${id}.title`)}
            body={t(`why.card.${id}.body`)}
            t={t}
          />
        ))}
      </div>

      <p className="mt-6 text-xs text-faint">{t("why.compatNote")}</p>

      <div className="mt-10">
        <Link
          href="/submit"
          className="inline-block rounded-lg bg-beacon px-5 py-2.5 font-medium text-neutral-950 hover:opacity-90"
        >
          {t("nav.list")}
        </Link>
      </div>
    </div>
  );
}
