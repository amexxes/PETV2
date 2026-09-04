export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[%_\/\\()\[\].,:;-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeKey(value: unknown): string {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = rows[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + cost);
      previous = temp;
    }
  }
  return rows[b.length];
}

export function similarity(aRaw: unknown, bRaw: unknown): number {
  const a = normalizeText(aRaw);
  const b = normalizeText(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size || 1;
  const jaccard = intersection / union;

  const maxLen = Math.max(a.length, b.length);
  const edit = maxLen ? 1 - levenshtein(a, b) / maxLen : 0;
  return Math.max(jaccard * 0.65 + edit * 0.35, edit * 0.75);
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const negativeByParentheses = /^\(.*\)$/.test(raw);
  const cleaned = raw
    .replace(/[€$£¥\s]/g, "")
    .replace(/^\(|\)$/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,(?=\d{3}(\D|$))/g, "")
    .replace(/,(\d{1,6})$/, ".$1")
    .replace(/%$/, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negativeByParentheses ? -parsed : parsed;
}

export function parsePercentage(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  const parsed = parseNumber(value);
  if (parsed === null) return null;
  if (raw.includes("%")) return parsed;
  if (Math.abs(parsed) <= 1) return parsed * 100;
  return parsed;
}

export function slug(value: string): string {
  const key = normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return key || "entity";
}
