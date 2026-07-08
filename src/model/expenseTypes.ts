// Domain model for the monthly expense tracker (a separate module from the
// retirement forecast). It reproduces Expenditure<year>.xlsx: a standard set
// of monthly expenses and income sources, snapshotted into an editable record
// for each actual month, so the joint current account can be kept above zero.
//
// Like Scenario, everything here is plain JSON (no Dates, no class instances):
// the store deep-copies via JSON and the whole object travels over the local API.
// All monetary values are GBP. Month keys are "yyyy-mm" (calendar months).

/** A recurring monthly expense as it appears in the standard list. */
export interface ExpenseTemplateItem {
  id: string;
  name: string;
  /** Day of the month the payment normally leaves the account (1–31), or null if it varies. */
  day: number | null;
  /** Default expected amount for a new month; 0 for items that vary every month (card bills). */
  amount: number;
  /** Investment account this payment goes INTO (an InvestmentAccount id such
   *  as "nick-isa"), or null for a normal expense. Tagged lines feed the
   *  pre-retirement forecast as contributions. */
  accountId: string | null;
}

/** A recurring monthly income source as it appears in the standard list. */
export interface IncomeTemplateItem {
  id: string;
  name: string;
  /** Default expected amount for a new month. */
  amount: number;
  /** Investment account this money is withdrawn FROM into the joint account
   *  (a PreAccountId), or null for normal income (salary etc.). */
  accountId: string | null;
}

export interface ExpenseTemplates {
  expenses: ExpenseTemplateItem[];
  income: IncomeTemplateItem[];
}

/** One expense line in an actual month (snapshot of a template item, or a one-off). */
export interface MonthExpenseItem {
  id: string;
  /** The template item this was created from; null for one-offs added to the month. */
  templateId: string | null;
  name: string;
  day: number | null;
  /** Expected amount this month (the override — edit freely). */
  amount: number;
  /** Amount actually paid so far this month. */
  paid: number;
  /** Investment account this payment goes INTO (contribution), or null.
   *  The pre-retirement forecast uses `amount` (expected), never `paid` —
   *  balance overrides are the actuals-anchoring mechanism. */
  accountId: string | null;
}

/** One income line in an actual month. */
export interface MonthIncomeItem {
  id: string;
  templateId: string | null;
  name: string;
  amount: number;
  /** Investment account this money is withdrawn FROM (into the joint account), or null. */
  accountId: string | null;
}

/** An actual calendar month being tracked. Created as a snapshot of the
 *  templates; every line can then be overridden, added or removed without
 *  affecting the standard list or other months. */
export interface ExpenseMonth {
  /** "yyyy-mm", unique — doubles as the persistence key. */
  key: string;
  /** Joint current account balance carried into the month. */
  startBalance: number;
  /** The account balance right now (user-entered mid-month); null until entered.
   *  Predicted month-end balance = currentBalance − what is still to pay. */
  currentBalance: number | null;
  expenses: MonthExpenseItem[];
  income: MonthIncomeItem[];
}

/** Root object for the expense tracker. Global (not per-scenario): these are
 *  actuals about the real account, so scenario duplicate/delete must never
 *  fork or destroy them. */
export interface ExpenseData {
  templates: ExpenseTemplates;
  months: ExpenseMonth[];
}

/** Starting point for a fresh install: a generic standard list with
 *  illustrative round amounts — rename and re-price to match your own.
 *  Deliberately synthetic: real payees and amounts live only in the local
 *  database, never in committed code. Variable items default to 0. */
export function defaultExpenseData(): ExpenseData {
  const e = (id: string, name: string, day: number | null, amount: number): ExpenseTemplateItem => ({
    id,
    name,
    day,
    amount,
    accountId: null,
  });
  return {
    templates: {
      expenses: [
        e("exp-savings", "Savings / Investments", 30, 0),
        e("exp-card-nick", "Credit Card Nick", 13, 0),
        e("exp-card-tracy", "Credit Card Tracy", 6, 0),
        e("exp-card-joint", "Credit Card Joint", 8, 0),
        e("exp-council-tax", "Council Tax", 1, 200),
        e("exp-cleaner", "Cleaner", null, 100),
        e("exp-energy", "Energy", 12, 200),
        e("exp-health", "Health Insurance", 9, 100),
        e("exp-mobile-nick", "Mobile Nick", 5, 40),
        e("exp-water", "Water", 1, 60),
        e("exp-broadband", "Broadband", 31, 40),
        e("exp-mobile-tracy", "Mobile Tracy", 15, 40),
        e("exp-dental", "Dental Plan", 1, 25),
        e("exp-insurance", "Insurance", 1, 20),
        e("exp-bank-fee", "Bank Fee", 27, 15),
      ],
      income: [
        { id: "inc-savings", name: "Savings", amount: 0, accountId: null },
        { id: "inc-salary-nick", name: "Salary Nick", amount: 2000, accountId: null },
        { id: "inc-salary-tracy", name: "Salary Tracy", amount: 2000, accountId: null },
        { id: "inc-dividends", name: "Dividends", amount: 0, accountId: null },
        { id: "inc-expenses", name: "Expenses", amount: 0, accountId: null },
      ],
    },
    months: [],
  };
}
