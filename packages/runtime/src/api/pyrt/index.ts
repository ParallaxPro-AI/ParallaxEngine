/**
 * pyrt — the Python semantics compiled game code runs on (contract C1). Compiled
 * modules import it as `parallax/__rt__`, bound to `$rt`. Everything here is either a
 * Python builtin (`len`, `range`, `print`, …), a stdlib shim (`math`, `random`, …) or an
 * operation the transpiler routes through it (`add`, `eq`, `getitem`, `attr`, `bind`, …).
 *
 * Calling convention: keyword arguments are ONE trailing `Kwargs` (`kw({...})`, from
 * `api/kwargs.ts`, the same class the api binds with `bindArgs`). See objects.ts.
 *
 * Representations (also what the api must hand game code): None → null, bool → boolean,
 * int/float → number, str → string, list → Array, tuple → frozen Array, dict → `PyDict`,
 * set → `PySet`, frozenset → `PyFrozenSet`. Type markers for annotations are api
 * `rt` (types.ts), re-exported here as `types`.
 */

export { kw, Kwargs } from '../kwargs.js';
export { rt as types } from '../types.js';

export {
  ArithmeticError, assertion_error, AssertionError, AttributeError, BaseException, Exception, exception_matches,
  exception_of, IndexError, KeyError, LookupError, NameError, NotImplementedError, OverflowError, raise_, raise_from,
  RecursionError, RuntimeError, StopIteration, TypeError, ValueError, ZeroDivisionError,
} from './errors.js';

export {
  add, and_, Ellipsis, eq, ge, gt, iadd, iand, ifloordiv, ilshift, imatmul, imod, imul, invert, ior, ipow, irshift,
  isub, iterate, itruediv, ixor, le, lshift, lt, matmul, mod, mul, ne, neg, NotImplemented, or_, pos, repr_float,
  rshift, str_float, sub, truediv, truthy, xor, floordiv,
} from './values.js';

export {
  delitem, dict_of, DictView, getitem, getslice, in_, PyDict, PyFrozenSet, PyRange, PySet, set_of, setitem, setslice,
  SPLAT, tup, unpack, unpack_star,
} from './collections.js';

export { format_float } from './format.js';
export { M } from './methods.js';

export {
  async_fn, attr, await_, bind, call, callm, class_attr, class_info, class_method, decorate_method, delattr, fn_annotations,
  getattr,
  hasattr, init_subclass, isCoroutine, kw_merge, mark_async, NO_DEFAULT, no_hash, PyObject, pyfn, set_method, setattr, sig, static_method,
} from './objects.js';
export type { Sig } from './objects.js';

export {
  abs, all, any, bin, bool, callable, chr, dict, divmod, enumerate, filter, float, format, frozenset, hash, hex, int, isinstance, issubclass, iter, len, list, map, max, min, next, object, oct, ord, pow, print, range,
  repr, reversed, round, set, setPrintSink, sorted, str, sum, tuple, type, zip,
} from './builtins.js';

export {
  collections, Counter, dataclasses, DefaultDict, Deque, enum_ as enum, enum_class, math, NamedTuple, Protocol,
  PyEnum, random, typing,
} from './stdlib.js';
