/** Joins class names, dropping falsy ones (CSS module keys can be undefined in tests). */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
