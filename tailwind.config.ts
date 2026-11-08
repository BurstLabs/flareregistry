import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // Toggle the .dark class on <html> to switch themes (class strategy, dark is the default).
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Beacon/flare palette
        flare: "#e84142",
        beacon: "#f5a623",
        // Theme tokens from globals.css, registered here so alpha modifiers work
        // (bg-elev/40, border-themed/60, divide-themed, ring-themed, bg-muted/30).
        // The hand-written classes in globals.css stay as a fallback for class names
        // Tailwind cannot see, and use the same values.
        elev: "rgb(var(--bg-elev) / <alpha-value>)",
        themed: "rgb(var(--border) / <alpha-value>)",
        muted: "rgb(var(--text-muted) / <alpha-value>)",
        faint: "rgb(var(--text-faint) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};

export default config;
