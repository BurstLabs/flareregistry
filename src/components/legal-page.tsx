"use client";

import { useApp } from "@/components/providers";

// Shared renderer for the Terms and Privacy pages. Content is a list of sections, each a heading key
// + one or more paragraph keys, all resolved through t() so the whole document is translatable. The
// page passes its key prefix (e.g. "terms" or "privacy") and the ordered section ids.
export function LegalPage({
  prefix,
  sections,
}: {
  prefix: string;
  sections: string[];
}) {
  const { t } = useApp();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t(`${prefix}.title`)}</h1>
      <p className="mt-2 text-sm text-faint">{t(`${prefix}.updated`)}</p>
      <p className="mt-4 leading-relaxed text-muted">{t(`${prefix}.intro`)}</p>

      <div className="mt-8 space-y-8">
        {sections.map((id) => (
          <section key={id}>
            <h2 className="text-lg font-semibold">{t(`${prefix}.s.${id}.h`)}</h2>
            {/* Each section may have up to 4 paragraphs (p1..p4); blanks are skipped. */}
            {["p1", "p2", "p3", "p4"].map((p) => {
              const key = `${prefix}.s.${id}.${p}`;
              const val = t(key);
              // t() returns the key itself when undefined; skip those so optional paragraphs vanish.
              if (val === key) return null;
              return (
                <p key={p} className="mt-2 leading-relaxed text-muted">
                  {val}
                </p>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
