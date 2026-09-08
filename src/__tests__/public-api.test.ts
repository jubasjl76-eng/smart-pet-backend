import { describe, it, expect } from 'vitest';
import { deriveLitterStatus } from '../breeder/routes/public.js';

describe('deriveLitterStatus', () => {
  it('passes through planning states before any puppies exist', () => {
    expect(deriveLitterStatus('planned', [])).toBe('planned');
    expect(deriveLitterStatus('expecting', [])).toBe('expecting');
  });

  it('is "born" once whelped but nothing is published', () => {
    expect(deriveLitterStatus('whelped', [])).toBe('born');
  });

  it('is "available" if any published puppy is available', () => {
    expect(
      deriveLitterStatus('whelped', [{ status: 'available' }, { status: 'sold' }]),
    ).toBe('available');
  });

  it('is "reserved" when placed but none free', () => {
    expect(
      deriveLitterStatus('weaning', [{ status: 'reserved' }, { status: 'sold' }]),
    ).toBe('reserved');
  });

  it('is "sold_out" when every puppy is gone', () => {
    expect(
      deriveLitterStatus('dispersed', [{ status: 'sold' }, { status: 'kept' }]),
    ).toBe('sold_out');
  });
});
