import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
// Fonts are bundled with the site (no request to Google at build, dev or visit time).
import "@fontsource-variable/tasa-orbiter/wght.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import StaticSearch from "@/components/docs/search";

export const metadata: Metadata = {
  title: "Lean Oracle",
  description: "Real-time market data for on-chain finance: exchange prices, signed every second, verifiable by CKB contracts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The site is dark only; `dark` selects Fumadocs' dark tokens, which globals.css retunes.
    <html lang="en" className="dark h-full antialiased" suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <RootProvider theme={{ enabled: false }} search={{ SearchDialog: StaticSearch }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
