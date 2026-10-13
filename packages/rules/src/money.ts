import type { Lakh } from './types.js';

/** Convert crore to lakh, rounding to a whole lakh. */
export const crore = (cr: number): Lakh => Math.round(cr * 100);

/** Format lakhs for display: "₹75 L", "₹1 cr", "₹14.5 cr", "₹2.25 cr". */
export function formatLakh(amount: Lakh): string {
  if (amount < 100) return `₹${amount} L`;
  const cr = amount / 100;
  const text = Number.isInteger(cr) ? String(cr) : cr.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `₹${text} cr`;
}
