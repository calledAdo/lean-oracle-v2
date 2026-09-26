import { useId } from "react";

const SHELL =
  "M22 3 C 33.5 3, 39.5 8, 39.5 19 C 39.5 31.5, 32 41, 22 41 C 12 41, 4.5 31.5, 4.5 19 C 4.5 8, 10.5 3, 22 3 Z";
const STEM = "M19.6 7.5 L 21.1 13.2 L 19.4 19.6 L 21.2 26.4 L 19.9 36.5";
const BRANCH = "M20.3 16.9 L 25.4 15.9 L 31.2 11.4";

/**
 * The Lean Oracle mark: 卜, the oracle-bone character for "to divine",
 * cut as a crack into a rounded shell.
 */
export function Mark({ className }: { className?: string }) {
  const mask = `crack-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 44 44" className={className} fill="none" aria-hidden="true">
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
        <rect width="44" height="44" fill="#fff" />
        <path d={STEM} stroke="#000" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d={BRANCH} stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <path d={SHELL} fill="var(--signal)" mask={`url(#${mask})`} />
    </svg>
  );
}
