export type WritingLanguage = "zh" | "en" | "ru";

/**
 * Infer the writing language from a free-text brief/premise when the user did not set one explicitly.
 *
 * Conservative by design: defaults to "zh" (preserving prior behaviour for Chinese users) and only
 * returns "en" when the text is clearly Latin-dominant. A Chinese brief that mentions an English name
 * or term still resolves to "zh"; incidental CJK inside an otherwise English brief resolves to "en".
 */
export function inferLanguage(text?: string | null): WritingLanguage {
  const t = text ?? "";
  const cjk = (t.match(/[一-鿿]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const cyrillic = (t.match(/[\u0400-\u04FF]/g) ?? []).length;
  if (cjk === 0 && cyrillic === 0 && latin > 0) return "en";
  if (cyrillic > 0 && cyrillic >= cjk && cyrillic * 4 >= latin) return "ru";
  if (latin > 0 && cjk * 4 < latin) return "en";
  return "zh";
}
