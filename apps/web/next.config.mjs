import { createMDX } from "fumadocs-mdx/next";

// GitHub Pages serves the site under /<repo>; the Pages workflow sets NEXT_PUBLIC_BASE_PATH.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const config = {
  // Static site: `next build` writes out/.
  output: "export",
  basePath,
  // Pages serves /docs/ as /docs/index.html.
  trailingSlash: true,
  images: { unoptimized: true },
};

export default createMDX()(config);
