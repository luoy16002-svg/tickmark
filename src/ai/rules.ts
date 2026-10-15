// Categories for a small business's books, and the plain rules that settle the common ones without a model.
import type { Transaction } from '../parse/statement.ts';

export const CATEGORIES = [
  'Sales income', 'Interest income', 'Refunds received', 'Transfers', 'Owner contributions', 'Owner drawings',
  'Payroll', 'Rent', 'Utilities', 'Phone & internet', 'Software & subscriptions', 'Cost of goods', 'Office & supplies',
  'Shipping & postage', 'Fuel & vehicle', 'Travel', 'Meals', 'Advertising', 'Professional services', 'Insurance',
  'Taxes', 'Bank fees', 'Loan payments', 'Cheques', 'Uncategorised',
] as const;
export type Category = (typeof CATEGORIES)[number];

const RULES: [RegExp, Category, 'in' | 'out' | 'any'][] = [
  [/\b(stripe|square inc|sq \*?deposit|shopify payout|paypal transfer|etsy deposit|amazon\.?com services|gumroad)\b/i, 'Sales income', 'in'],
  [/\b(mobile deposit|remote deposit|deposit ref|counter deposit|cash deposit)\b/i, 'Sales income', 'in'],
  [/\binterest (payment|paid|credit)\b|^interest\b/i, 'Interest income', 'in'],
  [/\brefund\b|\breversal\b|\breturn credit\b/i, 'Refunds received', 'in'],
  [/\b(payroll|gusto|adp|paychex|wages|salary|deel)\b/i, 'Payroll', 'out'],
  [/\brent\b|\blease\b/i, 'Rent', 'out'],
  [/\b(importers?|wholesalers?|distributors?|suppl(y|ies|ier)|packaging|ingredients)\b/i, 'Cost of goods', 'out'],
  [/\bwholesale\b/i, 'Sales income', 'in'],
  [/\b(pg&e|edison|con ed|duke energy|water|electric|gas co|utility|e\.on|octopus energy|british gas|enel)\b/i, 'Utilities', 'out'],
  [/\b(comcast|xfinity|verizon|at&t|t-mobile|vodafone|bt group|spectrum|o2|ee limited|tim s\.p\.a)\b/i, 'Phone & internet', 'out'],
  [/\b(amazon web services|aws|google \*?(workspace|gsuite|cloud)|microsoft|adobe|intuit|qbooks|quickbooks|xero|dropbox|slack|notion|github|zoom|atlassian|shopify \*|canva|openai|anthropic)\b/i, 'Software & subscriptions', 'out'],
  [/\b(ups|usps|fedex|dhl|royal mail|parcelforce|poste italiane)\b/i, 'Shipping & postage', 'out'],
  [/\b(shell|chevron|exxon|bp |texaco|esso|arco|76 |valero|fuel|petrol)\b/i, 'Fuel & vehicle', 'out'],
  [/\b(costco|staples|office depot|hardware|home depot|lowe'?s|ikea|amzn mktp|amazon mktp)\b/i, 'Office & supplies', 'out'],
  [/\b(irs|usataxpymt|eftps|hmrc|vat|franchise tax|agenzia entrate|f24)\b/i, 'Taxes', 'out'],
  [/\b(service fee|monthly fee|maintenance fee|wire (transfer )?(out )?fee|overdraft fee|account fee|commissioni|charges?)\b/i, 'Bank fees', 'out'],
  [/\b(insurance|geico|state farm|allianz|aviva|hiscox)\b/i, 'Insurance', 'out'],
  [/\b(check|cheque|chq)\s*#?\s*\d+/i, 'Cheques', 'out'],
  [/\b(transfer|tfr|xfer|online banking transfer)\b/i, 'Transfers', 'any'],
];

/** The category a plain rule gives this row, or undefined when it needs a person or the model. */
export function ruleFor(t: Transaction): Category | undefined {
  const dir = t.amount > 0 ? 'in' : 'out';
  for (const [re, cat, side] of RULES) {
    if ((side === 'any' || side === dir) && re.test(t.description)) return cat;
  }
  return undefined;
}

/** A merchant key that stays the same from month to month ("AMZN MKTP US*2K4T91" and "...*7Q1L0" match). */
export function payeeKey(description: string): string {
  return description.toUpperCase().replace(/[*#].*$/, '').replace(/\b\d[\d-]*\b/g, '').replace(/[^A-Z&' ]+/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
}

const STORE = 'tickmark.rules.v1';

export function rememberedRules(): Record<string, Category> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}');
  } catch {
    return {};
  }
}

export function remember(description: string, category: Category) {
  try {
    const r = rememberedRules();
    r[payeeKey(description)] = category;
    localStorage.setItem(STORE, JSON.stringify(r));
  } catch {
    /* private window: the choice holds for this session only */
  }
}

export function categorise(txs: Transaction[]) {
  const mine = rememberedRules();
  for (const t of txs) {
    if (t.categoryFrom === 'you') continue;
    const own = mine[payeeKey(t.description)];
    if (own) {
      t.category = own;
      t.categoryFrom = 'you';
      continue;
    }
    const r = ruleFor(t);
    if (r) {
      t.category = r;
      t.categoryFrom = 'rule';
    }
  }
}
