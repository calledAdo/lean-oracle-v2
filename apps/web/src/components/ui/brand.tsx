/** The Lean Oracle mark: the letter L drawn as a chart axis, holding one price candle. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 44 44" className={className} fill="none" aria-hidden="true">
      <path d="M11 5 V 39 H 39" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="20.5" y="12.5" width="8" height="15" rx="1.8" fill="var(--signal)" />
      <path d="M24.5 7.5 V 12.5 M24.5 27.5 V 32.5" stroke="var(--signal)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
