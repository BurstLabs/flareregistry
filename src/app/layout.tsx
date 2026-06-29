import "./globals.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { Providers } from "@/components/providers";
import { WalletProvider } from "@/components/wallet-provider";
import { wagmiConfig } from "@/lib/wagmi";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

const SITE_URL = "https://flareregistry.com";
const TITLE = "Flare Registry — FTSO Signal Provider Directory";
const DESCRIPTION =
  "Self-service registry for Flare and Songbird FTSO signal providers. Prove your address by signature and manage your own listing.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Flare Registry",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og-banner.png", width: 1200, height: 630, alt: "Flare Registry" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og-banner.png"],
  },
};

export const viewport: Viewport = { themeColor: "#0C0F16" };

// Applied before paint to avoid a flash of the wrong theme. Dark is the default.
const noFlashTheme = `(function(){try{var t=localStorage.getItem('fb_theme')||'dark';var e=document.documentElement;e.classList.remove('light','dark');e.classList.add(t);var l=localStorage.getItem('fb_locale');if(l)e.lang=l;}catch(_){document.documentElement.classList.add('dark')}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Hydrate wagmi from the request cookies so a connected wallet survives refresh without a
  // hydration-mismatch flash. cookieStorage persists the connection in a cookie (see lib/wagmi).
  const cookie = (await headers()).get("cookie");
  const initialState = cookieToInitialState(wagmiConfig, cookie);
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashTheme }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <WalletProvider initialState={initialState}>
          <Providers>
            <Header />
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
            <Footer />
          </Providers>
        </WalletProvider>
      </body>
    </html>
  );
}
