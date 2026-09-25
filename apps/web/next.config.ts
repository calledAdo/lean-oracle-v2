import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static site: `next build` writes out/, served by Caddy or GitHub Pages.
  output: "export",
};

export default nextConfig;
