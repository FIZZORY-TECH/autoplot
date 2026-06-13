/**
 * src/lib/portfolioMath.ts — Pure P&L math for the portfolio panel.
 *
 * Extracted from PortfolioPanel.tsx so the formulas can be unit-tested
 * independently of the React component. No side-effects, no imports.
 *
 * USD base / no FX per ADR-0010.
 */

// ---------------------------------------------------------------------------
// Per-holding row math
// ---------------------------------------------------------------------------

export interface HoldingPnl {
  /** Current market value: price × qty */
  value: number;
  /** Cost basis: avg_cost × qty */
  cost: number;
  /** Unrealized P&L: value − cost  (0 when avg_cost ≤ 0) */
  unrealized: number;
  /** Unrealized P&L %: (price − avg_cost) / avg_cost  (0 when avg_cost ≤ 0) */
  unrealizedPct: number;
  /** Weight in the total portfolio: value / totalValue  (0 when totalValue ≤ 0) */
  weightPct: number;
}

/**
 * Compute per-holding P&L metrics.
 *
 * @param price    Current market price (from market data; 0 when unknown).
 * @param qty      Quantity of the holding.
 * @param avg_cost Weighted-average cost per unit stored in the DB.
 * @param totalValue Sum of all holdings' current values (used for weight).
 */
export function holdingPnl(
  price: number,
  qty: number,
  avg_cost: number,
  totalValue: number,
): HoldingPnl {
  const value = price * qty;
  const cost = avg_cost * qty;
  const unrealized = avg_cost > 0 ? value - cost : 0;
  const unrealizedPct = avg_cost > 0 ? (price - avg_cost) / avg_cost : 0;
  const weightPct = totalValue > 0 ? value / totalValue : 0;
  return { value, cost, unrealized, unrealizedPct, weightPct };
}

// ---------------------------------------------------------------------------
// Portfolio-level summary math
// ---------------------------------------------------------------------------

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  unrealized: number;
  unrealizedPct: number;
  /** Fraction of totalValue in crypto holdings (0–1). */
  cryptoPct: number;
  /** Fraction of totalValue in equity holdings (0–1). */
  equityPct: number;
}

export interface SummaryHolding {
  qty: number;
  avg_cost: number;
  asset_class: string;
  price: number;
}

/**
 * Compute portfolio-level summary from a list of holdings with their current prices.
 */
export function portfolioSummary(holdings: SummaryHolding[]): PortfolioSummary {
  let totalValue = 0;
  let totalCost = 0;
  let cryptoValue = 0;
  let equityValue = 0;

  for (const h of holdings) {
    const value = h.price * h.qty;
    const cost = h.avg_cost * h.qty;
    totalValue += value;
    totalCost += cost;
    if (h.asset_class === 'equity') {
      equityValue += value;
    } else {
      cryptoValue += value;
    }
  }

  const unrealized = totalValue - totalCost;
  const unrealizedPct = totalCost > 0 ? unrealized / totalCost : 0;
  const cryptoPct = totalValue > 0 ? cryptoValue / totalValue : 0;
  const equityPct = totalValue > 0 ? equityValue / totalValue : 0;

  return { totalValue, totalCost, unrealized, unrealizedPct, cryptoPct, equityPct };
}
