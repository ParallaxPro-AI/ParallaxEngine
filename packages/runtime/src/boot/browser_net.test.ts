import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySignalingHub } from '../platform/index.js';
import { browserLobby, netFromUrl, rejoinKey } from './browser_net.js';

describe('netFromUrl', () => {
  const at = (query: string) => `http://localhost:5180/${query}`;
  it('reads host and join modes from the URL, the dev flags as defaults', () => {
    expect(netFromUrl(null, at(''))).toBeNull();
    expect(netFromUrl({ mode: 'join', server: 'ws://s/' }, at(''))).toEqual({ mode: 'join', server: 'ws://s/' });
    expect(netFromUrl(null, at('?net=host&signal=ws://r/&name=Ann'))).toEqual({ mode: 'host', signal: 'ws://r/', name: 'Ann' });
    expect(netFromUrl({ mode: 'host', signal: 'ws://r/' }, at('?net=join&room=ABCD'))).toEqual({ mode: 'join', signal: 'ws://r/', room: 'ABCD' });
    expect(netFromUrl(null, at('?net=join&server=ws://s:9/'))).toEqual({ mode: 'join', server: 'ws://s:9/' });
    expect(netFromUrl({ mode: 'host', signal: 'ws://r/' }, at('?net=off'))).toBeNull();
    expect(netFromUrl(null, at('?net=lobby&signal=ws://r/&name=Bo'))).toEqual({ mode: 'lobby', signal: 'ws://r/', name: 'Bo' });
    expect(() => netFromUrl(null, at('?net=lobby'))).toThrow(/PP9575/);
  });

  it('a lobby joiner reloads into the join link of its room', () => {
    const hub = new MemorySignalingHub();
    hub.connect().host({ name: 'Den', maxPlayers: 4, private: false, mode: '', map: '' }, 'Ann');
    const bob = hub.connect();
    bob.list();
    bob.join(bob.rooms[0]!.code, 'Bob');
    const went: string[] = [];
    browserLobby('ws://r/', (href) => went.push(href)).joinMatch(bob, 'Bob');
    const url = new URL(went[0]!);
    expect([url.searchParams.get('net'), url.searchParams.get('signal'), url.searchParams.get('room'), url.searchParams.get('name')])
      .toEqual(['join', 'ws://r/', bob.rooms[0]!.code, 'Bob']);
    expect(bob.state).toBe('closed');
  });

  it('rejects incomplete addresses with PP9575', () => {
    expect(() => netFromUrl(null, at('?net=host'))).toThrow(/PP9575/);
    expect(() => netFromUrl(null, at('?net=join'))).toThrow(/PP9575/);
    expect(() => netFromUrl(null, at('?net=join&room=X'))).toThrow(/PP9575/);
    expect(() => netFromUrl(null, at('?net=watch'))).toThrow(/PP9575/);
  });

  it('keeps rejoin tokens per game and per match', () => {
    expect(rejoinKey('g', { mode: 'join', server: 'ws://s/' })).toBe('parallax:g:rejoin:ws://s/');
    expect(rejoinKey('g', { mode: 'join', signal: 'ws://r/', room: 'AB' })).toBe('parallax:g:rejoin:ws://r/#AB');
  });
});

describe('ICE servers', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a host page\'s STUN/TURN servers reach the peer connections a lobby host opens', () => {
    const configs: unknown[] = [];
    // A peer that records its configuration and fails negotiation (the listener closes it).
    vi.stubGlobal('RTCPeerConnection', class {
      constructor(config: unknown) { configs.push(config); }
      createDataChannel(): never { throw new Error('stub'); }
      close(): void {}
    });
    const offer = { from: 'p1', payload: JSON.stringify({ kind: 'offer', sdp: 'v=0' }) };
    const signaling = { receive: () => [offer], send: () => {}, state: 'open', closeReason: null } as never;
    const turn = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }];
    const listen = (ice?: readonly object[]): void => {
      try { browserLobby('ws://r/', () => {}, ice).listener(signaling).accept(); } catch { /* the stub peer cannot negotiate */ }
    };
    listen(turn);
    listen();
    expect(configs).toEqual([{ iceServers: turn }, { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }]);
  });
});
