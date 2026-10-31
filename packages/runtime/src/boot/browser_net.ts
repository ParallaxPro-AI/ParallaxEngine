/**
 * A browser game's networking, from boot options and the page URL:
 *
 *   ?net=host&signal=ws://…[&room=CODE]   this browser hosts the match over WebRTC; peers
 *                                         find it through the signalling relay's room
 *   ?net=join&server=ws://…               join a dedicated server (WebSocket)
 *   ?net=join&signal=ws://…&room=CODE     join a browser-hosted match (WebRTC)
 *   ?net=lobby&signal=ws://…              play locally with `ctx.net.lobby` on the relay: the
 *                                         game lists, hosts and joins rooms; at the start the
 *                                         host keeps running and takes the members over
 *                                         WebRTC, and each joiner reloads into its join link
 *   &name=…                               the player's name (default "Player")
 *
 * A joining player's rejoin token is kept in sessionStorage per game and match, so a reload
 * (or a dropped tab restored) takes the same seat back within the server's rejoin window;
 * a new tab starts fresh.
 */

import { fail } from '../core/index.js';
import type { NetSession } from '../api/index.js';
import { browserPeer, WebRtcLink, WebRtcListener, WebSocketLink, WebSocketLobby, WebSocketSignaling } from '../platform/index.js';
import type { LobbyPlatform } from '../function/plugins/net/index.js';

export type BrowserNet =
  | { readonly mode: 'host'; readonly signal: string; readonly room?: string; readonly name?: string }
  | { readonly mode: 'join'; readonly server: string; readonly name?: string }
  | { readonly mode: 'join'; readonly signal: string; readonly room: string; readonly name?: string }
  | { readonly mode: 'lobby'; readonly signal: string; readonly name?: string };

/** The URL's `?net=` (and friends), else `defaults` (a host page's own settings). */
export function netFromUrl(defaults: BrowserNet | null = null, href: string = globalThis.location?.href ?? ''): BrowserNet | null {
  const params = new URL(href, 'http://localhost/').searchParams;
  const mode = params.get('net');
  const name = params.get('name') ?? undefined;
  const named = (net: BrowserNet): BrowserNet => (name === undefined ? net : { ...net, name });
  if (mode === null) return defaults === null ? null : named(defaults);
  if (mode === 'off') return null;
  const signal = params.get('signal') ?? (defaults !== null && 'signal' in defaults ? defaults.signal : null);
  const room = params.get('room') ?? undefined;
  const server = params.get('server') ?? (defaults !== null && 'server' in defaults ? defaults.server : null);
  if (mode === 'host') {
    if (signal === null) fail('PP9575', '?net=host needs a signalling relay (&signal=ws://…)', { fix: 'Add &signal=ws://… (a signalling relay, e.g. @parallax/server\'s) to the URL.' });
    return named({ mode: 'host', signal, ...(room !== undefined && { room }) } as BrowserNet);
  }
  if (mode === 'lobby') {
    if (signal === null) fail('PP9575', '?net=lobby needs a signalling relay (&signal=ws://…)', { fix: 'Add &signal= to the URL (the relay `parallax serve-relay` prints).' });
    return named({ mode: 'lobby', signal });
  }
  if (mode === 'join') {
    if (room !== undefined) {
      if (signal === null) fail('PP9575', '?net=join&room= needs the host\'s signalling relay (&signal=ws://…)', { fix: 'Use the join link the host printed.' });
      return named({ mode: 'join', signal, room });
    }
    if (server === null) fail('PP9575', '?net=join needs &server=ws://… (a dedicated server) or &room= (a browser host)', { fix: 'Use the join link the host printed.' });
    return named({ mode: 'join', server });
  }
  return fail('PP9575', `?net=${mode} is not a network mode`, { fix: 'Use ?net=host, ?net=join, ?net=lobby or ?net=off.' });
}

/** Where a rejoin token is kept: per game and match. */
export function rejoinKey(gameId: string, net: BrowserNet): string {
  return `parallax:${gameId}:rejoin:${'server' in net ? net.server : `${net.signal}#${'room' in net ? net.room ?? '' : ''}`}`;
}

function session(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

export function readRejoin(key: string): string | undefined {
  try { return session()?.getItem(key) ?? undefined; } catch { return undefined; }
}

export function writeRejoin(key: string, token: string): void {
  try { session()?.setItem(key, token); } catch { /* blocked storage: a reload joins as a new player */ }
}

export interface OpenedNet {
  readonly session: NetSession;
  /** The signalling relay of a hosted match (its room code arrives once the relay confirms). */
  readonly signaling?: WebSocketSignaling;
  /** This tab had a seat in the match: it asks for it back. */
  readonly rejoining: boolean;
  close(): void;
}

/**
 * Open the links a session needs. The links connect in the background; the net plugin pumps
 * them. `iceServers`: the WebRTC links' STUN/TURN servers (default: `browserPeer`'s).
 */
export function openNet(net: BrowserNet, gameId: string, iceServers?: readonly object[]): OpenedNet {
  const name = net.name ?? 'Player';
  if (net.mode === 'lobby') {
    return { session: { role: 'host', seats: 1, names: [name], lobby: browserLobby(net.signal, undefined, iceServers) }, rejoining: false, close: () => {} };
  }
  if (net.mode === 'host') {
    const signaling = WebSocketSignaling.host(net.signal, net.room);
    const listener = new WebRtcListener(signaling, browserPeer(iceServers));
    return { session: { role: 'host', seats: 1, names: [name], listener }, signaling, rejoining: false, close: () => listener.close() };
  }
  const key = rejoinKey(gameId, net);
  const rejoin = readRejoin(key);
  if ('server' in net) {
    const link = new WebSocketLink(net.server);
    return { session: { role: 'client', link, name, ...(rejoin !== undefined && { rejoin }) }, rejoining: rejoin !== undefined, close: () => link.close('left') };
  }
  const signaling = WebSocketSignaling.join(net.signal, net.room);
  const link = new WebRtcLink(signaling, browserPeer(iceServers));
  return { session: { role: 'client', link, name, ...(rejoin !== undefined && { rejoin }) }, signaling, rejoining: rejoin !== undefined, close: () => { link.close('left'); signaling.close('left'); } };
}

/**
 * `ctx.net.lobby` in a browser: rooms on the reference relay; the host's match over WebRTC on
 * the room's connection; a joiner reloads into `?net=join&signal=…&room=…&name=…` (the host
 * keeps its room, so the reloaded tab joins the running match).
 */
export function browserLobby(
  signal: string, navigate: (href: string) => void = (href) => { globalThis.location.assign(href); }, iceServers?: readonly object[],
): LobbyPlatform {
  return {
    connect: () => new WebSocketLobby(signal),
    listener: (connection) => new WebRtcListener(connection, browserPeer(iceServers)),
    joinMatch: (connection, name) => {
      const code = connection.room?.info.code;
      if (code === undefined) fail('PP9575', 'A lobby joiner has no room to join');
      const link = new URL(globalThis.location?.href ?? 'http://localhost/');
      link.searchParams.set('net', 'join');
      link.searchParams.set('signal', signal);
      link.searchParams.set('room', code);
      link.searchParams.set('name', name);
      connection.close('joining the match');
      navigate(link.href);
    },
  };
}
