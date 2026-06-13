/** One reorderable drink configuration. Prices are NOT authoritative — iOS
 *  renders the live price from the cached menu and the server recomputes the
 *  real total at checkout (Golden Rule #8). `lastUnitPriceCents` is a
 *  change-detection baseline for the iOS reorder guard only. */
export interface ReorderSignature {
  menuItemId: string;
  modifierIds: string[];
  quantity: number;
  lastUnitPriceCents: number;
}

export interface HomeSummaryResponse {
  /** Most-frequently ordered config across PAID orders, or null for a customer with no paid orders. */
  usual: ReorderSignature | null;
  /** Next most-frequent DISTINCT configs after `usual` (most-recent tiebreak). */
  recent: ReorderSignature[];
}
