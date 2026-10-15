// Categories for the rows the plain rules could not place, suggested by Gemma 4 on this computer. Each payee is
// asked about once and the answer goes to all its rows; an answer that contradicts the direction of the money
// (an expense category on money that came in) is thrown away. A suggestion is shown in italics until the reader
// confirms or changes it.
import type { Transaction } from '../parse/statement.ts';
import { ask } from './gemma.ts';
import { CATEGORIES, type Category, payeeKey } from './rules.ts';

const MONEY_IN = new Set<Category>(['Sales income', 'Interest income', 'Refunds received', 'Transfers', 'Owner contributions']);
const EITHER = new Set<Category>(['Transfers', 'Uncategorised']);

const PROMPT = (lines: string) => `You keep the books for a small business. Give each payee below one category from this list:
${CATEGORIES.join(', ')}.
"in" means the money came into the business's account: use Sales income for customers and payment processors, Interest income, Refunds received, Owner contributions or Transfers.
"out" means the money left: use an expense category. A supplier of the goods the business sells is Cost of goods.
Answer with one JSON object per line, like {"n":1,"category":"Office & supplies"}, and nothing else.

${lines}`;

function fits(c: Category, direction: 'in' | 'out'): boolean {
  if (EITHER.has(c)) return true;
  return direction === 'in' ? MONEY_IN.has(c) : !MONEY_IN.has(c);
}

export async function suggestCategories(txs: Transaction[], onRow?: () => void): Promise<number> {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.category) continue;
    const k = `${payeeKey(t.description)}|${t.amount > 0 ? 'in' : 'out'}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const payees = [...groups.values()];
  let placed = 0;
  for (let i = 0; i < payees.length; i += 12) {
    const batch = payees.slice(i, i + 12);
    const lines = batch.map((g, k) => `${k + 1}. ${g[0].amount > 0 ? 'in' : 'out'}, ${g[0].description}`).join('\n');
    const text = await ask(PROMPT(lines), 34 * batch.length + 40);
    for (const m of text.matchAll(/\{[^{}]*"n"\s*:\s*(\d+)[^{}]*"category"\s*:\s*"([^"]+)"[^{}]*\}/g)) {
      const g = batch[Number(m[1]) - 1];
      const c = CATEGORIES.find((x) => x.toLowerCase() === m[2].trim().toLowerCase()) as Category | undefined;
      if (!g || !c || !fits(c, g[0].amount > 0 ? 'in' : 'out')) continue;
      for (const t of g) {
        if (t.category) continue;
        t.category = c;
        t.categoryFrom = 'model';
        placed++;
      }
    }
    onRow?.();
  }
  return placed;
}
