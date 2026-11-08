// Stable slots (anti-jump): a live trial keeps its computer bay and its card until it ends.
// Ordering by start time would slide every trial to a new slot whenever one finished.
import { useRef } from "react";

/**
 * Assign `ids` to `n` slots, keeping each id where it already was. New ids take the first free
 * slot; ids that left free theirs. Ids beyond `n` are dropped (the caller shows "+ more").
 */
export function assignSlots(
  prev: readonly (string | null)[],
  ids: readonly string[],
  n: number,
): (string | null)[] {
  const live = new Set(ids);
  const next: (string | null)[] = Array.from({ length: n }, (_, i) => {
    const id = prev[i] ?? null;
    return id && live.has(id) ? id : null;
  });
  for (const id of ids) {
    if (next.includes(id)) continue;
    const free = next.indexOf(null);
    if (free < 0) break;
    next[free] = id;
  }
  return next;
}

/** The same, remembered across renders. */
export function useStableSlots(ids: readonly string[], n: number): (string | null)[] {
  const prev = useRef<(string | null)[]>([]);
  const next = assignSlots(prev.current, ids, n);
  prev.current = next;
  return next;
}
