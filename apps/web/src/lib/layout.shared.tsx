import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Mark } from "@/components/ui/brand";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-heading text-[15px] font-semibold tracking-tight">
          <Mark className="size-6" />
          Lean Oracle
        </span>
      ),
      url: "/",
    },
    themeSwitch: { enabled: false },
    githubUrl: "https://github.com/calledAdo/lean-oracle-v2",
    links: [{ text: "npm", url: "https://www.npmjs.com/package/lean-oracle-sdk", external: true }],
  };
}
