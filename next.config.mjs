/** @type {import('next').NextConfig} */

// Security response headers (S11). Applied to every route. We intentionally do NOT set a strict CSP
// here: the WalletConnect/Reown SDK loads wallet popups and remote scripts, and a tight CSP risks
// breaking signing. X-Frame-Options: DENY gives clickjacking protection (the app is never framed),
// and HSTS forces HTTPS. Cloudflare/Nginx may also set some of these; duplicates are harmless.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // PERSISTENT TURBOPACK BUILD CACHE.
    //
    // Without this every deploy recompiled the entire app from scratch. .next/cache held only
    // fetch-cache and images, no compiler cache at all, and the compile step was ~34s of a ~49s
    // build. Measured on the production box after enabling it: a warm build compiles in 7.9s and
    // finishes in 22s, so a deploy that changes a few files no longer pays to rebuild everything.
    //
    // The cache lives in .next/cache and survives because the deploy builds in place rather than
    // into a clean directory. It costs about 400MB of disk, which is nothing against the 116GB free
    // on that volume. The first build after enabling it is SLOWER (65s) because it populates the
    // cache; every build after is the fast path.
    turbopackFileSystemCacheForBuild: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // The detection work moved to oracleindependence.com, which runs its own database and pipeline.
  //
  // REDIRECTED, not deleted. flareregistry.com/detection is cited as the method URL in a governance
  // proposal and in correspondence already sent to providers; breaking those links would strand the
  // one reference readers were given. 308 is permanent and preserves the method, so the API redirects
  // stay usable rather than silently turning POSTs into GETs.
  async redirects() {
    return [
      { source: "/detection", destination: "https://oracleindependence.com/method", permanent: true },
      { source: "/independence", destination: "https://oracleindependence.com/", permanent: true },
      { source: "/api/detection", destination: "https://oracleindependence.com/api/detection", permanent: true },
      { source: "/api/independence", destination: "https://oracleindependence.com/api/independence", permanent: true },
    ];
  },
};

export default nextConfig;
