import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SEARCH_BUDGET_MS, DEFAULT_SEARCH_MAX_INFLIGHT, SearchOverloadedError,
  budgetExceeded, createSearchAdmission, searchBudgetMs, searchMaxInflight,
} from '../budget.ts';

describe('search budget env parsing', () => {
  test('defaults when unset/blank/invalid/zero/negative (validate.ts requires positive integers)', () => {
    for (const raw of [undefined, '', '  ', 'abc', '0', '-1', '1.5']) {
      expect(searchBudgetMs(raw)).toBe(DEFAULT_SEARCH_BUDGET_MS);
      expect(searchMaxInflight(raw)).toBe(DEFAULT_SEARCH_MAX_INFLIGHT);
    }
  });
  test('explicit positive integers are honoured', () => {
    expect(searchBudgetMs('1')).toBe(1);
    expect(searchBudgetMs('2500')).toBe(2500);
    expect(searchMaxInflight('1')).toBe(1);
    expect(searchMaxInflight('12')).toBe(12);
  });
  test('budgetExceeded compares elapsed against the budget inclusively', () => {
    expect(budgetExceeded(1000, 20, 1019)).toBe(false);
    expect(budgetExceeded(1000, 20, 1020)).toBe(true);
    expect(budgetExceeded(1000, 0, 1000)).toBe(true);
  });
});

describe('search admission gate', () => {
  test('admits up to the limit, refuses beyond it with a 503-class error, releases exactly once', () => {
    let limit = 2;
    const gate = createSearchAdmission(() => limit);
    const r1 = gate.acquire();
    const r2 = gate.acquire();
    expect(gate.inflight).toBe(2);
    expect(() => gate.acquire()).toThrow(SearchOverloadedError);
    try { gate.acquire(); } catch (e) {
      const err = e as SearchOverloadedError;
      expect(err.status).toBe(503);
      expect(err.inflight).toBe(2);
      expect(err.maxInflight).toBe(2);
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
    }
    r1(); r1();                       // double release must not go negative
    expect(gate.inflight).toBe(1);
    r2();
    expect(gate.inflight).toBe(0);
    limit = 0;                        // limit is read on every acquire (env-driven in production)
    expect(() => gate.acquire()).toThrow(SearchOverloadedError);
  });
});
