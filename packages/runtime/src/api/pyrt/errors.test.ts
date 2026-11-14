import { describe, expect, it } from 'vitest';
import { BaseException, Exception, ValueError } from './errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python attributes are untyped */

describe('pyrt exceptions', () => {
  it('message and name follow str() and the class name by default', () => {
    const e = new ValueError('bad value');
    expect(e.message).toBe('bad value');
    expect(e.name).toBe('ValueError');
  });

  it('a subclass may assign self.message / self.name as ordinary attributes (as in CPython)', () => {
    // class GameError(Exception):
    //     def __init__(self, kind, message): super().__init__(message); self.kind = kind; self.message = message
    class GameError extends Exception {
      override __init__(...args: unknown[]): void {
        super.__init__(args[1]);
        (this as any).kind = args[0];
        (this as any).message = args[1];
        (this as any).name = 'friendly';
      }
    }
    const e = new GameError('bad_move', 'Try again');
    expect((e as any).message).toBe('Try again');
    expect((e as any).name).toBe('friendly');
    expect((e as any).kind).toBe('bad_move');
    (e as any).message = 'changed';
    expect((e as any).message).toBe('changed');
    // Other instances keep the defaults.
    const plain = new Exception('x');
    expect(plain.message).toBe('x');
    expect(plain.name).toBe('Exception');
    expect(e).toBeInstanceOf(BaseException);
  });
});
