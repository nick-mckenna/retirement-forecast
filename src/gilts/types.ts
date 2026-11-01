import type { PersonId } from "../model/types";

/**
 * Real UK gilts, from the Debt Management Office's public reports (D1A "gilts in issue" and
 * D10B "purchase and sale service prices"). All plain JSON, like the rest of the model.
 *
 * Only conventional gilts are modelled: index-linked gilts are listed (so the picker can show
 * them) but cannot be held or bought.
 */

/** What a holding needs to know to generate its cash flows: the coupon and the redemption date.
 *  Coupons are paid half-yearly on the redemption day-of-month, in the redemption month and six
 *  months either side of it. */
export interface GiltTerms {
  /** Annual coupon as a decimal (0.0025 for a ¼% gilt). */
  couponRate: number;
  /** Redemption (maturity) date, ISO yyyy-mm-dd. */
  redemptionDate: string;
}

export interface GiltInstrument extends GiltTerms {
  isin: string;
  /** DMO name, e.g. "0 1/4% Treasury Gilt 2031". */
  name: string;
  indexLinked: boolean;
  /** A rump gilt: a small, illiquid remnant — never used to fit the curve or bought. */
  rump: boolean;
}

/** One day's DMO purchase-and-sale-service prices, per £100 nominal. The clean prices are what
 *  the model uses; DMO's dirty prices are for settlement three business days later and are
 *  kept for reference only. */
export interface GiltPrice {
  isin: string;
  /** Trade date the prices are for, ISO. */
  priceDate: string;
  buyClean: number;
  buyDirty: number;
  sellClean: number;
  sellDirty: number;
}

/** The gilt market as the app knows it: every instrument in issue, the latest price of each and,
 *  for the gilts the user holds, the price history needed to value them at past dates. */
export interface GiltMarket {
  /** Date of the latest prices (the curve is fitted there); null when nothing has been fetched. */
  asOf: string | null;
  instruments: GiltInstrument[];
  prices: GiltPrice[];
}

/** A purchase of a real gilt held in a pre-retirement gilt account. Self-contained (name, coupon
 *  and redemption date are stored with it) so it still works after the gilt has redeemed and
 *  dropped out of the DMO list, and without any market data at all. */
export interface GiltLot extends GiltTerms {
  id: string;
  /** The `InvestmentAccount` (kind "gilts") it is held in. */
  accountId: string;
  isin: string;
  name: string;
  /** Nominal (face value) bought, £. */
  nominal: number;
  /** Settlement date of the purchase, ISO. */
  purchaseDate: string;
  /** Clean price paid per £100 nominal; null = the DMO buy price on that date (par if unknown). */
  purchaseCleanPrice: number | null;
}

/** A real gilt held at the retirement start date, handed from the pre-retirement projection to
 *  the engine. */
export interface OpeningGilt extends GiltTerms {
  holder: PersonId;
  isin: string;
  name: string;
  nominal: number;
  /** Accrued interest paid on purchase that the next coupon is relieved of (Accrued Income
   *  Scheme): only the excess of that coupon over this is taxable. */
  aisCredit: number;
}

/** Inputs to `simulate` that are not part of the persisted `Scenario`: data resolved at run time
 *  (the real gilts handed over from the pre-retirement module and the market to price them). */
export interface SimContext {
  giltMarket?: GiltMarket | null;
  openingGilts?: OpeningGilt[];
}
