/**
 * Match tickets: how an orchestrator lets exactly the players it matched into a match. The
 * matchmaker signs a ticket per player; the player connects with it in the URL
 * (`/match/<id>?ticket=…`); the gate verifies it before the game sees the link, and hands
 * the game the player's identity (name, seat, and the id that lets a dropped player rejoin).
 *
 * Format: `v1.<payload>.<signature>`, both base64url; the payload is the claims as JSON and
 * the signature HMAC-SHA256(secret, "v1." + payload). Claims: `match` (this match's id),
 * `user` (stable player id), `name`, `seat` (or null), `exp` (unix seconds) and `jti` (a
 * unique ticket id: each ticket is spent once).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NetIdentity, NetLink } from '@parallax/runtime/core';
import type { AdmissionGate } from './sim_adapter.js';

export interface TicketClaims {
  readonly match: string;
  readonly user: string;
  readonly name: string;
  readonly seat: number | null;
  readonly exp: number;
  readonly jti: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function sign(secret: string, payload: string): Uint8Array {
  return createHmac('sha256', secret).update(`v1.${payload}`).digest();
}

export function signTicket(secret: string, claims: TicketClaims): string {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  return `v1.${payload}.${b64url(sign(secret, payload))}`;
}

/** The claims of a valid ticket for `match`, or why it isn't one. Checks signature, shape, expiry and match. */
export function verifyTicket(secret: string, ticket: string, match: string, nowSeconds: number): TicketClaims | { readonly reject: string } {
  if (ticket.length > 4096) return { reject: 'ticket too long' };
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { reject: 'not a v1 ticket' };
  let given: Uint8Array;
  let claims: Record<string, unknown>;
  try {
    given = unb64url(parts[2]!);
    const expected = sign(secret, parts[1]!);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { reject: 'bad signature' };
    claims = JSON.parse(decoder.decode(unb64url(parts[1]!))) as Record<string, unknown>;
  } catch {
    return { reject: 'malformed ticket' };
  }
  const seat = claims['seat'];
  if (typeof claims['match'] !== 'string' || typeof claims['user'] !== 'string' || typeof claims['name'] !== 'string'
    || typeof claims['exp'] !== 'number' || typeof claims['jti'] !== 'string'
    || !(seat === null || (Number.isInteger(seat) && (seat as number) >= 0))) {
    return { reject: 'ticket claims malformed' };
  }
  if (claims['exp'] < nowSeconds) return { reject: 'ticket expired' };
  if (claims['match'] !== match) return { reject: 'ticket is for another match' };
  return claims as unknown as TicketClaims;
}

export interface TicketGateOptions {
  readonly secret: string;
  readonly match: string;
  /** Unix seconds now (default: the wall clock). */
  readonly now?: () => number;
}

/**
 * A gate for links that carry their request path (the WebSocket listener's connections):
 * `?ticket=` must be a valid, unspent ticket for this match.
 */
export function ticketGate(options: TicketGateOptions): AdmissionGate<NetLink & { readonly path: string }> {
  const spent = new Map<string, number>();
  const now = options.now ?? (() => Date.now() / 1000);
  return (link) => {
    const t = now();
    for (const [jti, exp] of spent) if (exp < t) spent.delete(jti);
    const query = link.path.includes('?') ? link.path.slice(link.path.indexOf('?') + 1) : '';
    const ticket = new URLSearchParams(query).get('ticket');
    if (ticket === null) return { reject: 'no ticket' };
    const claims = verifyTicket(options.secret, ticket, options.match, t);
    if ('reject' in claims) return claims;
    if (spent.has(claims.jti)) return { reject: 'ticket already used' };
    spent.set(claims.jti, claims.exp);
    const identity: NetIdentity = { id: claims.user, name: claims.name, seat: claims.seat };
    return identity;
  };
}
