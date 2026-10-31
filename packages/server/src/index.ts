/**
 * @parallax/server — dedicated hosting for Parallax games: a WebSocket listener implementing
 * the engine's net port, `SimAdapter` (the seam a match orchestrator drives), match tickets,
 * `serveGame` (the smallest orchestrator), and a signalling relay for browser-hosted matches.
 */

export { acceptKey, CLOSE, encodeFrame, FrameReader, WebSocketConnection, WebSocketListener } from './websocket.js';
export type { WebSocketListenerOptions } from './websocket.js';
export { serveGame, SERVER_FRAME } from './serve.js';
export type { DrainOptions, GameServer, ServeOptions } from './serve.js';
export { Admission, createMatchSim, IdentifiedLink } from './sim_adapter.js';
export type { AdmissionGate, MatchSimInfo, MatchSimOptions, MatchStatus, SimAdapter } from './sim_adapter.js';
export { signTicket, ticketGate, verifyTicket } from './tickets.js';
export type { TicketClaims, TicketGateOptions } from './tickets.js';
export { SignalingRelay } from './signaling.js';
export type { RelayOptions } from './signaling.js';
