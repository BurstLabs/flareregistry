import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Flare Registry — FTSO Signal Provider Directory",
  description:
    "Self-service registry for Flare and Songbird FTSO signal providers. Prove your address by signature and manage your own listing.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

// Applied before paint to avoid a flash of the wrong theme. Dark is the default.
const noFlashTheme = `(function(){try{var t=localStorage.getItem('fb_theme')||'dark';var e=document.documentElement;e.classList.remove('light','dark');e.classList.add(t);var l=localStorage.getItem('fb_locale');if(l)e.lang=l;}catch(_){document.documentElement.classList.add('dark')}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashTheme }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
