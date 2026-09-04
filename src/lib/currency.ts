const FALLBACK_CURRENCY_CODES = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS",
  "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
  "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF",
  "YER", "ZAR", "ZMW", "ZWL",
] as const;

const intlWithSupportedValues = Intl as typeof Intl & {
  supportedValuesOf?: (key: string) => string[];
};

const supportedCodes = (() => {
  try {
    return intlWithSupportedValues.supportedValuesOf?.("currency") ?? [];
  } catch {
    return [];
  }
})();

const CURRENCY_CODES = new Set<string>([
  ...FALLBACK_CURRENCY_CODES,
  ...supportedCodes,
]);

const CODE_ALIASES: Record<string, string> = {
  RMB: "CNY",
  CNH: "CNY",
  UKP: "GBP",
  EURO: "EUR",
  EUROS: "EUR",
};

const PREFIX_ALIASES: Array<[string, string]> = [
  ["US$", "USD"],
  ["USD$", "USD"],
  ["HK$", "HKD"],
  ["A$", "AUD"],
  ["AU$", "AUD"],
  ["C$", "CAD"],
  ["CA$", "CAD"],
  ["NZ$", "NZD"],
  ["S$", "SGD"],
  ["SG$", "SGD"],
  ["R$", "BRL"],
  ["CN¥", "CNY"],
  ["RMB¥", "CNY"],
  ["JP¥", "JPY"],
];

const UNIQUE_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "₩": "KRW",
  "₽": "RUB",
  "₺": "TRY",
  "₫": "VND",
  "₪": "ILS",
  "฿": "THB",
  "₴": "UAH",
  "₦": "NGN",
  "₱": "PHP",
  "₡": "CRC",
  "₲": "PYG",
  "₵": "GHS",
  "₭": "LAK",
  "₮": "MNT",
};

const NAME_ALIASES: Array<[RegExp, string]> = [
  [/\bUS DOLLARS?\b/i, "USD"],
  [/\bHONG KONG DOLLARS?\b/i, "HKD"],
  [/\bAUSTRALIAN DOLLARS?\b/i, "AUD"],
  [/\bCANADIAN DOLLARS?\b/i, "CAD"],
  [/\bNEW ZEALAND DOLLARS?\b/i, "NZD"],
  [/\bSINGAPORE DOLLARS?\b/i, "SGD"],
  [/\bPOUNDS? STERLING\b/i, "GBP"],
  [/\bSWISS FRANCS?\b/i, "CHF"],
  [/\bSOUTH AFRICAN RAND\b/i, "ZAR"],
  [/\bJAPANESE YEN\b/i, "JPY"],
  [/\bCHINESE (?:YUAN|RENMINBI)\b/i, "CNY"],
  [/\bINDIAN RUPEES?\b/i, "INR"],
  [/\bEUROS?\b/i, "EUR"],
];

export function isCurrencyCode(value: unknown): boolean {
  const code = String(value ?? "").trim().toUpperCase();
  return CURRENCY_CODES.has(CODE_ALIASES[code] ?? code);
}

export function extractCurrencyCode(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const upper = raw.toUpperCase();

  const direct = CODE_ALIASES[upper] ?? upper;
  if (CURRENCY_CODES.has(direct)) return direct;

  for (const [prefix, code] of [...PREFIX_ALIASES].sort((first, second) => second[0].length - first[0].length)) {
    if (upper.includes(prefix)) return code;
  }

  for (const [pattern, code] of NAME_ALIASES) {
    if (pattern.test(raw)) return code;
  }

  const tokens = upper.match(/[A-Z]{3}/g) ?? [];
  for (const token of tokens) {
    const code = CODE_ALIASES[token] ?? token;
    if (CURRENCY_CODES.has(code)) return code;
  }

  for (const [symbol, code] of Object.entries(UNIQUE_SYMBOLS)) {
    if (raw.includes(symbol)) return code;
  }

  return undefined;
}

export function dominantCurrencyCode(values: unknown[], minimumDominance = 0.6): string | undefined {
  const counts = new Map<string, number>();
  let recognised = 0;
  for (const value of values) {
    const code = extractCurrencyCode(value);
    if (!code) continue;
    recognised += 1;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (!recognised) return undefined;
  const ranked = [...counts.entries()].sort((first, second) => second[1] - first[1]);
  const [code, count] = ranked[0] ?? [];
  if (!code || count / recognised < minimumDominance) return undefined;
  return code;
}

export function uniqueCurrencyCode(values: unknown[]): string | undefined {
  const codes = new Set(values.map(extractCurrencyCode).filter((value): value is string => Boolean(value)));
  return codes.size === 1 ? [...codes][0] : undefined;
}

export function stripCurrencyDecorators(value: string): string {
  let result = value;
  const detected = extractCurrencyCode(result);
  if (detected) {
    result = result.replace(new RegExp(detected, "gi"), "");
    for (const [alias, code] of Object.entries(CODE_ALIASES)) {
      if (code === detected) result = result.replace(new RegExp(alias, "gi"), "");
    }
  }
  for (const [pattern] of NAME_ALIASES) result = result.replace(pattern, "");
  for (const [prefix] of [...PREFIX_ALIASES].sort((first, second) => second[0].length - first[0].length)) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), "");
  }
  result = result.replace(/[€£¥₹₩₽₺₫₪฿₴₦₱₡₲₵₭₮$]/g, "");
  return result;
}
