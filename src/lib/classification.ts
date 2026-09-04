import type { AccountMapping, AccountingClass, TaxClassification } from "./types";
import { normalizeKey, normalizeText } from "./text";

interface Rule {
  accountingClass: AccountingClass;
  taxClassification: TaxClassification;
  confidence: number;
  keywords: string[];
  note: string;
}

const RULES: Rule[] = [
  {
    accountingClass: "participation",
    taxClassification: "not_relevant",
    confidence: 0.97,
    keywords: ["investment in subsidiary", "investment in subsidiaries", "participation", "deelneming", "beteiligung", "shares in group company", "shares in subsidiary"],
    note: "Participation carrying amount is excluded when the underlying entities are analysed, to prevent double counting.",
  },
  {
    accountingClass: "inventory",
    taxClassification: "operating",
    confidence: 0.96,
    keywords: ["inventory", "inventories", "stock", "merchandise", "voorraad", "vorrat"],
    note: "Operating-asset signal.",
  },
  {
    accountingClass: "fixed_assets",
    taxClassification: "operating",
    confidence: 0.95,
    keywords: [
      "fixed assets",
      "fixed asset",
      "machinery",
      "machine",
      "plant and equipment",
      "property plant equipment",
      "ppe",
      "equipment",
      "furniture and equip",
      "construction in progress",
      "leasehold",
      "leashold",
      "accum dep",
      "depreciation",
      "tangible asset",
      "materiele vaste activa",
    ],
    note: "Operating fixed-asset signal, subject to actual use and fair-value review.",
  },
  {
    accountingClass: "trade_receivable",
    taxClassification: "operating",
    confidence: 0.86,
    keywords: ["trade receivable", "trade debtors", "accounts receivable", "customer receivable", "debtors", "debiteuren", "handelsforderungen"],
    note: "Usually operating when arising from ordinary short-term trade credit; factual review may still be needed.",
  },
  {
    accountingClass: "investment",
    taxClassification: "potential_free_investment",
    confidence: 0.94,
    keywords: ["marketable securities", "securities", "security portfolio", "investment portfolio", "portfolio investment", "bond", "bonds", "investment fund", "financial investment", "treasury investment", "effecten", "waardepapieren", "obligatie", "anleihe"],
    note: "Strong free-investment signal. Low-tax status must still be established.",
  },
  {
    accountingClass: "group_financing",
    taxClassification: "manual_review",
    confidence: 0.95,
    keywords: [
      "intercompany receivable",
      "intercompany loan",
      "inter entity receivable",
      "inter entity loan",
      "group receivable",
      "group loan",
      "related party receivable",
      "related party loan",
      "shareholder loan",
      "due from fellow subsidiaries",
      "due from fellow subsidiary",
      "due from affiliate",
      "due from affiliates",
      "affiliate receivable",
      "icr service agreement",
      "verbonden lening",
      "groepsvordering",
      "konzerndarlehen",
    ],
    note: "Group financing requires specific tax-rule review and may qualify for an exception.",
  },
  {
    accountingClass: "cash",
    taxClassification: "manual_review",
    confidence: 0.93,
    keywords: ["cash and cash equivalents", "cash equivalent", "cash", "bank account", "bank balance", "bank balances", "deposit", "liquid funds", "liquide middelen", "bankguthaben"],
    note: "Cash is not automatically a free investment; purpose and required working capital must be assessed.",
  },
  {
    accountingClass: "real_estate",
    taxClassification: "manual_review",
    confidence: 0.87,
    keywords: ["investment property", "real estate", "property", "building", "land", "vastgoed", "onroerend goed", "immobilien", "grundstuck"],
    note: "Real-estate assets require the specific statutory treatment rather than a keyword-only conclusion.",
  },
  {
    accountingClass: "other_asset",
    taxClassification: "manual_review",
    confidence: 0.82,
    keywords: ["other receivable", "other receivables", "deferred tax asset", "deferred tax assets", "prepayment", "prepayments", "other current asset", "other non current asset"],
    note: "Asset detected, but its tax classification requires review.",
  },
];

const NON_ASSET_KEYWORDS = [
  "accounts payable",
  "trade payable",
  "creditor",
  "liability",
  "liabilities",
  "current laibilities",
  "equity",
  "reserve",
  "share capital",
  "retained earnings",
  "revenue",
  "sales",
  "income",
  "expense",
  "cost of sales",
  "tax payable",
  "payroll",
  "crediteuren",
  "eigen vermogen",
  "omzet",
  "kosten",
];

function includesKeyword(text: string, keyword: string): boolean {
  const normalized = normalizeText(keyword);
  return text === normalized || text.includes(normalized);
}

function nonAssetFromStatementContext(category: string, side: string): string | undefined {
  const context = normalizeText(`${side} ${category}`);
  if (["p&l", "p l", "profit and loss", "income statement"].some((keyword) => context.includes(keyword))) return "profit-and-loss account";
  return NON_ASSET_KEYWORDS.find((keyword) => includesKeyword(context, keyword));
}

export function mappingKey(glAccount: string, description: string): string {
  return `${normalizeKey(glAccount)}|${normalizeKey(description)}`;
}

export function classifyAccount(glAccount: string, description: string, category = "", side = ""): AccountMapping {
  const text = normalizeText(`${description} ${category} ${side}`);
  const nonAsset = nonAssetFromStatementContext(category, side) ?? NON_ASSET_KEYWORDS.find((keyword) => includesKeyword(normalizeText(description), keyword));
  if (nonAsset) {
    return {
      key: mappingKey(glAccount, description),
      glAccount,
      description,
      accountingClass: "non_asset",
      taxClassification: "not_relevant",
      confidence: 0.97,
      signals: [`Non-asset signal: ${nonAsset}`],
      source: "rule",
    };
  }

  const matches = RULES.map((rule) => ({ rule, hits: rule.keywords.filter((keyword) => includesKeyword(text, keyword)) }))
    .filter((candidate) => candidate.hits.length > 0)
    .sort((first, second) => second.rule.confidence - first.rule.confidence || second.hits.length - first.hits.length);

  if (matches.length) {
    const { rule, hits } = matches[0];
    return {
      key: mappingKey(glAccount, description),
      glAccount,
      description,
      accountingClass: rule.accountingClass,
      taxClassification: rule.taxClassification,
      confidence: Math.min(0.99, rule.confidence + Math.min(0.03, (hits.length - 1) * 0.01)),
      signals: [...hits.map((hit) => `Keyword/context: ${hit}`), rule.note],
      source: "rule",
    };
  }

  const statementContext = normalizeText(`${side} ${category}`);
  const assetSignal = statementContext.includes("asset") || statementContext.includes("activa");
  if (assetSignal) {
    return {
      key: mappingKey(glAccount, description),
      glAccount,
      description,
      accountingClass: "other_asset",
      taxClassification: "manual_review",
      confidence: 0.68,
      signals: ["Financial-statement grouping indicates an asset, but no reliable tax-classification rule matched."],
      source: "rule",
    };
  }

  return {
    key: mappingKey(glAccount, description),
    glAccount,
    description,
    accountingClass: "unknown",
    taxClassification: "manual_review",
    confidence: 0.35,
    signals: ["No reliable classification rule matched and the row was not identified as an asset."],
    source: "rule",
  };
}

export function isAssetClass(accountingClass: AccountingClass): boolean {
  return !["non_asset", "unknown"].includes(accountingClass);
}
