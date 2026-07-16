"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useApp } from "./providers";
import { WalletButton } from "./wallet-button";
import { LOCALES, LOCALE_NAMES } from "@/lib/i18n";

export function Header() {
  const { t, theme, toggleTheme, locale, setLocale } = useApp();
  const router = useRouter();
  const pathname = usePathname();

  // "List your provider" -> /submit. If we're already on /submit (e.g. /submit?manage=1), a plain
  // <Link> to the same pathname is a no-op, so the manage param never clears. Force a full reload
  // to /submit so the page restarts in the fresh create flow.
  function goToSubmit(e: React.MouseEvent) {
    if (pathname === "/submit") {
      e.preventDefault();
      window.location.href = "/submit";
    }
  }
  const [langOpen, setLangOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Primary links stay inline; secondary/informational links collapse into the "More" dropdown on
  // desktop. The mobile panel lists everything flat (it has the vertical room). "Powered by" is not
  // in the nav: it is surfaced by the glowing homepage pill and the footer.
  const primaryLinks: { href: string; label: string; external?: boolean }[] = [
    { href: "/", label: t("nav.directory") },
    { href: "/submit", label: t("nav.list") },
    { href: "/api/feed/providerlist.json", label: t("nav.feed"), external: true },
    { href: "/api", label: t("nav.api") },
  ];
  const moreLinks: { href: string; label: string; external?: boolean }[] = [
    { href: "/why", label: t("nav.why") },
    { href: "/governance", label: t("nav.governance") },
    { href: "/faq", label: t("nav.faq") },
  ];
  const navLinks = [...primaryLinks, ...moreLinks];

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-themed bg-elev/80 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" aria-label="Flare Registry" className="flex items-center">
          <Image
            src={theme === "dark" ? "/logo-wordmark-dark.v2.png" : "/logo-wordmark.v2.png"}
            alt="Flare Registry"
            width={928}
            height={200}
            priority
            className="h-8 w-auto"
          />
        </Link>

        <div className="flex items-center gap-1 sm:gap-3">
          <Link href="/" className="hidden px-2 text-sm text-muted hover:text-beacon sm:inline">
            {t("nav.directory")}
          </Link>
          <Link
            href="/submit"
            onClick={goToSubmit}
            className="hidden px-2 text-sm text-muted hover:text-beacon sm:inline"
          >
            {t("nav.list")}
          </Link>
          <a
            href="/api/feed/providerlist.json"
            target="_blank"
            rel="noreferrer"
            className="hidden px-2 text-sm text-muted hover:text-beacon sm:inline"
          >
            {t("nav.feed")}
          </a>
          <Link href="/api" className="hidden px-2 text-sm text-muted hover:text-beacon sm:inline">
            {t("nav.api")}
          </Link>

          {/* "More" dropdown: secondary/informational links, kept off the main bar to declutter. */}
          <div className="relative hidden sm:block" ref={moreRef}>
            <button
              onClick={() => setMoreOpen((o) => !o)}
              aria-expanded={moreOpen}
              className="flex items-center gap-1 px-2 text-sm text-muted hover:text-beacon"
            >
              {t("nav.more")}
              <ChevronIcon open={moreOpen} />
            </button>
            {moreOpen && (
              <div className="absolute right-0 mt-2 w-40 overflow-hidden rounded-md border border-themed bg-elev shadow-lg">
                {moreLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setMoreOpen(false)}
                    className="block px-3 py-2 text-sm text-muted hover:bg-black/5 hover:text-beacon dark:hover:bg-white/5"
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Wallet connect / account */}
          <WalletButton />

          {/* Language selector */}
          <div className="relative" ref={langRef}>
            <button
              onClick={() => setLangOpen((o) => !o)}
              aria-label={t("toggle.language")}
              className="flex items-center gap-1 rounded-md border border-themed px-2 py-1.5 text-sm text-muted hover:text-beacon"
            >
              <GlobeIcon />
              <span className="hidden sm:inline">{LOCALE_NAMES[locale]}</span>
            </button>
            {langOpen && (
              <div className="absolute right-0 mt-1 w-36 overflow-hidden rounded-md border border-themed bg-elev shadow-lg">
                {LOCALES.map((l) => (
                  <button
                    key={l}
                    onClick={() => {
                      setLocale(l);
                      setLangOpen(false);
                    }}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${
                      l === locale ? "text-beacon" : "text-muted"
                    }`}
                  >
                    {LOCALE_NAMES[l]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            aria-label={t("toggle.theme")}
            className="rounded-md border border-themed p-1.5 text-muted hover:text-beacon"
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>

          {/* Mobile menu button (links are hidden below sm) */}
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={t("nav.menu")}
            aria-expanded={menuOpen}
            className="rounded-md border border-themed p-1.5 text-muted hover:text-beacon sm:hidden"
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </nav>

      {/* Mobile nav panel */}
      {menuOpen && (
        <div className="border-t border-themed sm:hidden">
          <nav className="mx-auto flex max-w-5xl flex-col px-4 py-2">
            {navLinks.map((l) =>
              l.external ? (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMenuOpen(false)}
                  className="py-2 text-sm text-muted hover:text-beacon"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={(e) => {
                    setMenuOpen(false);
                    if (l.href === "/submit") goToSubmit(e);
                  }}
                  className="py-2 text-sm text-muted hover:text-beacon"
                >
                  {l.label}
                </Link>
              )
            )}
          </nav>
        </div>
      )}
    </header>
  );
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
