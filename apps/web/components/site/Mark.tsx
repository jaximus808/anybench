/**
 * The Anybench mark: a 3×3 trial grid. Seven cells passed, one failed its gate, one is still
 * running (the amber one). It is the product in nine pixels.
 */
const CELLS = ["p", "p", "f", "p", "r", "p", "p", "p", "p"] as const;
const FILL = { p: "var(--fg)", f: "var(--line-strong)", r: "var(--accent)" } as const;

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true">
      {CELLS.map((c, i) => (
        <rect
          key={i}
          x={(i % 3) * 7 + 1}
          y={Math.floor(i / 3) * 7 + 1}
          width="6"
          height="6"
          rx="1"
          fill={FILL[c]}
        />
      ))}
    </svg>
  );
}
