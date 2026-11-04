// Masks things that rarely help a work summary but often leak in window titles: addresses, tokens, long numbers.
const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[メール]'],
  [/\b(https?:\/\/[^\s/?#]+)[^\s]*/gi, (_m, origin) => `${origin}/…`],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})\b/g, '[秘密情報]'],
  [/\b[0-9a-f]{32,}\b/gi, '[ID]'],
  // phone / card / account numbers: 10+ digits, so dates (8 digits) and times survive
  [/(?<![\d:])\d(?:[\d -]{8,})\d(?![\d:])/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[番号]' : m)],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep as string);
  return out;
}

/** Neutralise tag-like text so recorded titles can't close the <timeline> wrapper around them. */
export function defang(text: string): string {
  return text.replace(/</g, '＜').replace(/>/g, '＞');
}
