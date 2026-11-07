export const isLeap = (y) => y % 4 === 0; // bug: centuries
export function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
} // bug: Jan 31 + 1
export function isoWeek(d) {
  const t = new Date(d);
  return Math.ceil(((t - new Date(t.getFullYear(), 0, 1)) / 864e5 + 1) / 7);
} // bug: ISO rules
