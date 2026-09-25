import type { Metadata } from "next";
// Fonts are bundled with the site (no request to Google at build, dev or visit time).
import "@fontsource-variable/tasa-orbiter/wght.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lean Oracle",
  description: "Exchange prices signed every second by a publisher committee, verified by your CKB contract.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
