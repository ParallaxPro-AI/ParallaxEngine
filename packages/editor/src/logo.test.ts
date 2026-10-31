import { describe, expect, it, vi } from 'vitest';
import { logoClickPlan } from './logo.js';

const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe('the logo', () => {
  it('without a host action is a plain link (the site, in a new tab)', () => {
    expect(logoClickPlan(plain, null)).toBe('native');
    expect(logoClickPlan({ ...plain, metaKey: true }, null)).toBe('native');
  });

  it("a host's href: a plain click goes there in this tab, a modified or middle click opens it natively", () => {
    const action = { href: '/projects' };
    expect(logoClickPlan(plain, action)).toBe('navigate');
    expect(logoClickPlan({ ...plain, ctrlKey: true }, action)).toBe('native');
    expect(logoClickPlan({ ...plain, metaKey: true }, action)).toBe('native');
    expect(logoClickPlan({ ...plain, shiftKey: true }, action)).toBe('native');
    expect(logoClickPlan({ ...plain, button: 1 }, action)).toBe('native');
  });

  it("a host's onClick replaces the plain click; without an href nothing else happens", () => {
    const onClick = vi.fn();
    expect(logoClickPlan(plain, { href: '/projects', onClick })).toBe('run');
    expect(logoClickPlan(plain, { onClick })).toBe('run');
    expect(logoClickPlan({ ...plain, metaKey: true }, { onClick })).toBe('none');
    expect(logoClickPlan(plain, {})).toBe('none');
  });
});
