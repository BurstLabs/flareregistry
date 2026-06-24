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
      },
    },
  },
  plugins: [],
};

export default config;
