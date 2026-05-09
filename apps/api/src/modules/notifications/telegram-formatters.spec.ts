import {
  formatCents,
  formatCustomerName,
  formatItemList,
  formatOrderShortId,
} from './telegram-formatters';

// =============================================================================
// telegram-formatters — pure helpers for assembling Spec Part 9 alert bodies.
//
// Edge cases pinned here so future template tweaks don't silently regress
// the alert format. Each formatter is independently tested.
// =============================================================================

describe('formatCustomerName', () => {
  it('two-word name → first + last initial', () => {
    expect(formatCustomerName('Sarah Mitchell')).toBe('Sarah M.');
  });

  it('single-word name returns as-is (no last initial to add)', () => {
    expect(formatCustomerName('Madonna')).toBe('Madonna');
  });

  it('three-word name abbreviates the LAST word, keeps the middle', () => {
    expect(formatCustomerName('Mary Jane Watson')).toBe('Mary Jane W.');
  });

  it('empty string returns empty string (not a throw)', () => {
    expect(formatCustomerName('')).toBe('');
  });

  it('whitespace-only string returns empty string', () => {
    expect(formatCustomerName('   ')).toBe('');
  });

  it('trims surrounding whitespace before splitting', () => {
    expect(formatCustomerName('  Sarah Mitchell  ')).toBe('Sarah M.');
  });

  it('collapses multiple spaces between names', () => {
    expect(formatCustomerName('Sarah    Mitchell')).toBe('Sarah M.');
  });
});

describe('formatCents', () => {
  it('1000 → "$10.00"', () => {
    expect(formatCents(1000)).toBe('$10.00');
  });

  it('0 → "$0.00"', () => {
    expect(formatCents(0)).toBe('$0.00');
  });

  it('999 → "$9.99"', () => {
    expect(formatCents(999)).toBe('$9.99');
  });

  it('large values format without scientific notation', () => {
    // $1 million in cents = 100_000_000. Plausible for a daily-summary line
    // someday; doesn't matter for a single coffee order, but we guarantee
    // the formatter doesn't degrade for big inputs.
    expect(formatCents(100_000_000)).toBe('$1000000.00');
  });

  it('handles odd cents (cents = 1) → "$0.01"', () => {
    expect(formatCents(1)).toBe('$0.01');
  });
});

describe('formatItemList', () => {
  it('single item with quantity 1 → just the name', () => {
    expect(formatItemList([{ name: 'Oat Latte', quantity: 1 }])).toBe('Oat Latte');
  });

  it('two items with quantity 1 each → joined with " + "', () => {
    expect(
      formatItemList([
        { name: 'Oat Latte', quantity: 1 },
        { name: 'Muffin', quantity: 1 },
      ]),
    ).toBe('Oat Latte + Muffin');
  });

  it('quantity > 1 appends "x{n}" to the item name', () => {
    expect(
      formatItemList([
        { name: 'Oat Latte', quantity: 2 },
        { name: 'Muffin', quantity: 1 },
      ]),
    ).toBe('Oat Latte x2 + Muffin');
  });

  it('empty list returns empty string (defensive — caller shouldn\'t reach this)', () => {
    expect(formatItemList([])).toBe('');
  });

  it('all items with quantity > 1', () => {
    expect(
      formatItemList([
        { name: 'Oat Latte', quantity: 12 },
        { name: 'Croissant', quantity: 3 },
      ]),
    ).toBe('Oat Latte x12 + Croissant x3');
  });
});

describe('formatOrderShortId', () => {
  it('truncates a UUID to its first 8 chars and prefixes "#"', () => {
    expect(
      formatOrderShortId('abc12345-6789-4def-89ab-cdef01234567'),
    ).toBe('#abc12345');
  });

  it('handles non-UUID inputs gracefully (slice does not throw)', () => {
    // Defensive: if anyone ever passes a non-UUID, the formatter doesn't
    // crash. The caller is responsible for passing a real order id.
    expect(formatOrderShortId('abc')).toBe('#abc');
  });

  it('handles empty input → "#" (degenerate but non-crashing)', () => {
    expect(formatOrderShortId('')).toBe('#');
  });
});
