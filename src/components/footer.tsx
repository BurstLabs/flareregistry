"use client";

import Link from "next/link";
import Image from "next/image";
import { useApp } from "./providers";

export function Footer() {
  const { t, theme } = useApp();
  return (
    <footer className="mt-16 border-t border-themed">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-sm">
          <Image
            src={theme === "dark" ? "/logo-wordmark-dark.v2.png" : "/logo-wordmark.v2.png"}
            alt="Flare Registry"
            width={928}
            height={200}
            className="h-9 w-auto"
          />
          <p className="mt-2 text-sm text-muted">{t("footer.tagline")}</p>
        </div>
        {/* Product: the core actions, mirroring the primary links in the top nav. */}
        <nav className="flex flex-col gap-2 text-sm">
          <div className="font-medium">{t("footer.product")}</div>
          <Link href="/" className="text-muted hover:text-beacon">
            {t("footer.directory")}
          </Link>
          <Link href="/submit" className="text-muted hover:text-beacon">
            {t("footer.list")}
          </Link>
          <a
            href="/api/feed/providerlist.json"
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-beacon"
          >
            {t("footer.feed")}
          </a>
          <Link href="/api" className="text-muted hover:text-beacon">
            {t("footer.api")}
          </Link>
        </nav>
        {/* Learn: the informational/secondary links, mirroring the "More" menu in the top nav. */}
        <nav className="flex flex-col gap-2 text-sm">
          <div className="font-medium">{t("footer.learn")}</div>
          <Link href="/why" className="text-muted hover:text-beacon">
            {t("nav.why")}
          </Link>
          <Link href="/governance" className="text-muted hover:text-beacon">
            {t("nav.governance")}
          </Link>
          <Link href="/powered-by" className="text-muted hover:text-beacon">
            {t("nav.poweredBy")}
          </Link>
          <Link href="/faq" className="text-muted hover:text-beacon">
            {t("nav.faq")}
          </Link>
          <Link href="/terms" className="text-muted hover:text-beacon">
            {t("nav.terms")}
          </Link>
          <Link href="/privacy" className="text-muted hover:text-beacon">
            {t("nav.privacy")}
          </Link>
        </nav>
        <div className="flex flex-col gap-2 text-sm">
          <div className="font-medium">{t("footer.support")}</div>
          <p className="max-w-xs text-muted">{t("footer.supportText")}</p>
          <Link href="/contact" className="text-beacon hover:underline">
            {t("footer.contact")}
          </Link>
        </div>
      </div>
      <div className="border-t border-themed">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-4 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
          <span>Flare Registry. {t("footer.rights")}</span>
          <span>
            {t("footer.builtBy")}{" "}
            <a
              href="https://www.burstlabs.io"
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-beacon"
            >
              Burst Labs
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
