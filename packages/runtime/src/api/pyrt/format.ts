/**
 * `format(value, spec)` and f-string fields: Python's format-spec mini-language.
 * Floats are rounded on their exact binary value, half to even — what CPython does, and
 * what `Number.prototype.toFixed` does not (`(0.125).toFixed(2)` is "0.13", Python "0.12").
 */

import { typeError, ValueError } from './errors.js';
import { floatRepr, str, typeName } from './values.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;

// ── Exact decimal arithmetic on doubles ───────────────────────────────────────

/** |x| = int / 10**scale exactly. */
function exact(x: number): { int: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (biased === 0) e2 = -1074;
  else {
    mantissa |= 1n << 52n;
    e2 = biased - 1075;
  }
  if (e2 >= 0) return { int: mantissa << BigInt(e2), scale: 0 };
  return { int: mantissa * 5n ** BigInt(-e2), scale: -e2 };
}

/** Round int/10**scale to `places` decimals, half to even: the digits of the result × 10**places. */
function roundTo(int: bigint, scale: number, places: number): bigint {
  if (places >= scale) return int * 10n ** BigInt(places - scale);
  const div = 10n ** BigInt(scale - places);
  let q = int / div;
  const r = int % div;
  const twice = 2n * r;
  if (twice > div || (twice === div && q % 2n === 1n)) q += 1n;
  return q;
}

/** Fixed notation with `places` decimals of |x|. */
export function fixedDigits(x: number, places: number): string {
  const { int, scale } = exact(x);
  const digits = roundTo(int, scale, places).toString().padStart(places + 1, '0');
  return places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/** |x| rounded to `sig` significant digits: [digit string, decimal exponent of the first digit]. */
function significant(x: number, sig: number): [string, number] {
  if (x === 0) return ['0'.repeat(sig), 0];
  const { int, scale } = exact(x);
  const total = int.toString().length;
  let exp = total - 1 - scale;
  let digits = roundTo(int, scale, sig - 1 - exp).toString();
  if (digits.length > sig) {
    exp += 1;
    digits = digits.slice(0, sig);
  }
  return [digits, exp];
}

/** CPython `round(x, n)` for floats: correctly rounded, half to even. */
export function roundFloat(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  if (ndigits > 330) return x;
  if (ndigits < -330) return 0 * Math.sign(x);
  const { int, scale } = exact(x);
  const q = roundTo(int, scale, ndigits);
  const text = ndigits >= 0 ? `${q}e-${ndigits}` : `${q}e${-ndigits}`;
  const value = Number(text);
  return x < 0 ? -value : value;
}

// ── Spec parsing ──────────────────────────────────────────────────────────────

interface Spec {
  fill: string;
  align: string | null;
  sign: string;
  z: boolean;
  alt: boolean;
  zero: boolean;
  width: number;
  grouping: string;
  precision: number | null;
  type: string;
}

const SPEC = /^(?:(.)?([<>=^]))?([+\- ])?(z)?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/su;

function parse(spec: string): Spec {
  const m = SPEC.exec(spec);
  if (m === null) throw new ValueError('Invalid format specifier');
  const [, fill, align, sign, z, alt, zero, width, grouping, precision, type] = m;
  return {
    fill: fill ?? (zero !== undefined && align === undefined ? '0' : ' '),
    align: align ?? (zero !== undefined ? '=' : null),
    sign: sign ?? '-',
    z: z !== undefined,
    alt: alt !== undefined,
    zero: zero !== undefined,
    width: width !== undefined ? Number(width) : 0,
    grouping: grouping ?? '',
    precision: precision !== undefined ? Number(precision) : null,
    type: type ?? '',
  };
}

function pad(body: string, prefix: string, s: Spec, defaultAlign: string): string {
  const align = s.align ?? defaultAlign;
  const len = Array.from(prefix + body).length;
  const n = Math.max(0, s.width - len);
  if (n === 0) return prefix + body;
  const fill = s.fill.repeat(n);
  switch (align) {
    case '<': return prefix + body + fill;
    case '>': return fill + prefix + body;
    case '=': return prefix + fill + body;
    default: {
      const left = s.fill.repeat(Math.floor(n / 2));
      return left + prefix + body + s.fill.repeat(n - Math.floor(n / 2));
    }
  }
}

function group(intDigits: string, sep: string, every: number): string {
  if (!sep) return intDigits;
  let out = '';
  for (let i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % every === 0) out += sep;
    out += intDigits[i];
  }
  return out;
}

/** Sign + grouped number, zero-padded into the grouping when `0`/`=` asks for it. */
function finishNumber(negative: boolean, prefix: string, intDigits: string, rest: string, s: Spec, every: number): string {
  const sign = negative ? '-' : s.sign === '+' ? '+' : s.sign === ' ' ? ' ' : '';
  const head = sign + prefix;
  if (s.fill === '0' && s.align === '=' && s.width > 0) {
    let digits = intDigits;
    let grouped = group(digits, s.grouping, every);
    while (head.length + grouped.length + rest.length < s.width) {
      digits = `0${digits}`;
      grouped = group(digits, s.grouping, every);
    }
    return head + grouped + rest;
  }
  return pad(group(intDigits, s.grouping, every) + rest, head, s, '>');
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatInt(x: number, s: Spec): string {
  if (s.precision !== null) throw new ValueError('Precision not allowed in integer format specifier');
  const negative = x < 0;
  const big = BigInt(Math.abs(x));
  switch (s.type) {
    case 'b': return finishNumber(negative, s.alt ? '0b' : '', big.toString(2), '', s, 4);
    case 'o': return finishNumber(negative, s.alt ? '0o' : '', big.toString(8), '', s, 4);
    case 'x': return finishNumber(negative, s.alt ? '0x' : '', big.toString(16), '', s, 4);
    case 'X': return finishNumber(negative, s.alt ? '0X' : '', big.toString(16).toUpperCase(), '', s, 4);
    case 'c': return pad(String.fromCodePoint(x), '', s, '<');
    default: return finishNumber(negative, '', big.toString(), '', s, 3);
  }
}

function formatFloat(x: number, s: Spec): string {
  let negative = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  const upper = s.type === 'E' || s.type === 'F' || s.type === 'G';
  if (!Number.isFinite(x)) {
    const word = Number.isNaN(x) ? 'nan' : 'inf';
    if (Number.isNaN(x)) negative = false;
    return finishNumber(negative, '', upper ? word.toUpperCase() : word, '', { ...s, grouping: '' }, 3);
  }
  let body: string;
  let suffix = '';
  const p = s.precision;
  switch (s.type) {
    case 'f': case 'F': body = fixedDigits(ax, p ?? 6); if (s.alt && (p ?? 6) === 0) body += '.'; break;
    case '%': body = fixedDigits(ax * 100, p ?? 6); if (s.alt && (p ?? 6) === 0) body += '.'; suffix = '%'; break;
    case 'e': case 'E': body = sci(ax, p ?? 6, s.alt, upper); break;
    case 'g': case 'G': case 'n': body = general(ax, p ?? 6, s.alt, upper, false); break;
    default:
      body = p === null ? floatRepr(ax) : general(ax, p, s.alt, false, true);
  }
  if (s.z && negative && /^[0.]*$/.test(body.replace(/e.*$/i, ''))) negative = false;
  const dot = body.search(/[.eE]/);
  const intDigits = dot < 0 ? body : body.slice(0, dot);
  return finishNumber(negative, '', intDigits, body.slice(intDigits.length) + suffix, s, 3);
}

function sci(ax: number, p: number, alt: boolean, upper: boolean): string {
  const [digits, exp] = significant(ax, p + 1);
  const mant = p === 0 ? `${digits}${alt ? '.' : ''}` : `${digits[0]}.${digits.slice(1)}`;
  const e = `${upper ? 'E' : 'e'}${exp < 0 ? '-' : '+'}${Math.abs(exp).toString().padStart(2, '0')}`;
  return mant + e;
}

/** 'g', and the no-type form with a precision (which keeps one decimal in fixed
 * notation and switches to exponents one digit earlier). */
function general(ax: number, precision: number, alt: boolean, upper: boolean, noType: boolean): string {
  const P = precision === 0 ? 1 : precision;
  const exp = ax === 0 ? 0 : significant(ax, P)[1];
  if (exp >= -4 && exp < (noType ? P - 1 : P)) {
    let out = fixedDigits(ax, P - 1 - exp);
    if (!alt && out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
    if (noType && !out.includes('.')) out += '.0';
    return out;
  }
  const out = sci(ax, P - 1, alt, upper);
  return alt ? out : out.replace(/(\.\d*?)0+(?=[eE])/, '$1').replace(/\.(?=[eE])/, '');
}

function formatStr(text: string, s: Spec): string {
  if (s.sign !== '-' || (s.align === '=')) throw new ValueError('Sign not allowed in string format specifier');
  if (s.type !== '' && s.type !== 's') throw new ValueError(`Unknown format code '${s.type}' for object of type 'str'`);
  const body = s.precision !== null ? Array.from(text).slice(0, s.precision).join('') : text;
  return pad(body, '', s, '<');
}

function formatNumber(x: number, spec: string, isFloat: boolean): string {
  const s = parse(spec);
  const floatType = 'eEfFgG%'.includes(s.type) && s.type !== '';
  if (isFloat || !Number.isInteger(x) || floatType) {
    if ('bcdoxX'.includes(s.type) && s.type !== '') {
      throw new ValueError(`Unknown format code '${s.type}' for object of type 'float'`);
    }
    if (s.type === 's') throw new ValueError("Unknown format code 's' for object of type 'float'");
    if (!isFloat && Number.isInteger(x) && !floatType && s.precision === null) return formatInt(x, s);
    return formatFloat(x, s);
  }
  if (s.type === 's') throw new ValueError("Unknown format code 's' for object of type 'int'");
  if (s.type === 'n') return formatInt(x, { ...s, type: 'd' });
  return formatInt(x, s);
}

/** `format(value, spec)` / `f"{value:spec}"`. */
export function format(value: unknown, spec: unknown = ''): string {
  if (typeof spec !== 'string') throw typeError(`format() argument 2 must be str, not ${typeName(spec)}`);
  if (typeof value === 'string') return spec === '' ? value : formatStr(value, parse(spec));
  if (typeof value === 'number') return spec === '' ? str(value) : formatNumber(value, spec, false);
  if (typeof value === 'boolean') return spec === '' ? (value ? 'True' : 'False') : formatNumber(+value, spec, false);
  if (value !== null && value !== undefined && typeof (value as Any).__format__ === 'function') {
    const r = (value as Any).__format__(spec);
    if (typeof r !== 'string') throw typeError(`__format__ must return a str, not ${typeName(r)}`);
    return r;
  }
  if (spec === '') return str(value);
  throw typeError(`unsupported format string passed to ${typeName(value)}.__format__`);
}

/** `f"{x}"` where the transpiler knows x is a float. */
export function format_float(value: unknown, spec: unknown = ''): string {
  if (typeof value !== 'number') return format(value, spec);
  if (spec === '') return floatRepr(value);
  if (typeof spec !== 'string') throw typeError(`format() argument 2 must be str, not ${typeName(spec)}`);
  return formatNumber(value, spec, true);
}
