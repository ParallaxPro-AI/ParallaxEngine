/**
 * Python's `NotImplemented` singleton: a binary dunder (`__add__`, `__mul__`, …) returns it
 * for an operand type it doesn't handle, so the other operand's reflected method gets a
 * turn and, failing that, the operator raises Python's TypeError (pyrt `binaryDunder`).
 * It lives in core so value types can return it; pyrt re-exports it to compiled code.
 */
export const NotImplemented: object = Object.freeze({ __repr__: () => 'NotImplemented' });
