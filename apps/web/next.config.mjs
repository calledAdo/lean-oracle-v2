import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  // Static site: `next build` writes out/, served by Caddy or GitHub Pages.
  output: "export",
};

export default createMDX()(config);
