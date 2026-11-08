/** The Anybench mark: two bars, the taller one in the accent colour. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="9" width="8" height="14" rx="2" fill="var(--line-strong)" />
      <rect x="15" y="3" width="8" height="20" rx="2" fill="var(--accent)" />
    </svg>
  );
}
