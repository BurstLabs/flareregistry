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
