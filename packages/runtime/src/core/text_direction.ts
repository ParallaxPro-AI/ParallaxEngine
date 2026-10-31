/**
 * Which way a language reads. The UI surface lays every panel out right to left for a
 * right-to-left language (Arabic, Hebrew, Persian, Urdu…): it sets `dir="rtl"` and `lang`
 * on the UI layer, `dir` inherits into every panel, so a panel's CSS needs no language list
 * of its own — `:dir(rtl)` or logical properties (`margin-inline-start`, `inset-inline-end`)
 * mirror with it.
 *
 * The tag is a BCP-47 language tag as a game's locale file is named (`ar`, `ar-EG`, `he_IL`,
 * `az-Arab`). A script subtag decides when there is one (`az-Arab` reads right to left,
 * `ku-Latn` left to right); otherwise the language does. Anything unrecognized reads left to
 * right: mirroring a UI on a guess is the louder failure.
 */

export type TextDirection = 'ltr' | 'rtl';

/** Right-to-left language subtags (CLDR's set in current use), lowercase. */
export const RTL_LANGUAGES: readonly string[] = [
  'ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi',
];

/** Right-to-left script subtags, lowercase. */
const RTL_SCRIPTS: readonly string[] = ['arab', 'aran', 'hebr', 'thaa', 'nkoo', 'syrc', 'adlm', 'rohg', 'yezi'];

function subtagsOf(tag: string | null | undefined): string[] {
  if (typeof tag !== 'string') return [];
  return tag.trim().toLowerCase().replace(/_/g, '-').split('-').filter((s) => s !== '');
}

/** The direction a language tag reads in. */
export function textDirectionOf(tag: string | null | undefined): TextDirection {
  const parts = subtagsOf(tag);
  if (parts.length === 0) return 'ltr';
  // A script subtag is four letters and never first.
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (/^[a-z]{4}$/.test(part)) return RTL_SCRIPTS.includes(part) ? 'rtl' : 'ltr';
  }
  return RTL_LANGUAGES.includes(parts[0]!) ? 'rtl' : 'ltr';
}
