/**
 * The browser's voice device (core `VoiceDevice`): the microphone through `getUserMedia`
 * (echo cancellation, noise suppression and gain control by the browser), one
 * `RTCPeerConnection` per peer carrying Opus audio both ways, and playback through Web
 * Audio — each peer's stream → gain → stereo panner → speakers, so the voice plugin's
 * distance gain and pan apply.
 *
 * Signals are JSON text: `{"sdp": {type, sdp}}` and `{"ice": RTCIceCandidateInit}`. The
 * initiator adds an audio transceiver and makes the offer; the other side answers. The
 * microphone may go live after links are open: its track replaces the silent sender.
 *
 * Chromium only pulls audio from a remote WebRTC stream into Web Audio while a media
 * element plays it, so each peer also gets a muted <audio> element (never audible itself).
 */

import type { MicState, VoiceDevice, VoicePeer, VoicePlayback, VoiceSignal } from '../../core/index.js';

export interface WebRtcVoiceOptions {
  /** STUN/TURN servers for the peer connections (the host's). */
  readonly iceServers?: RTCIceServer[];
  /** Shared with the game's audio when given (one context per page is kinder to phones). */
  readonly context?: AudioContext;
  /** Opus bitrate cap, bits per second (default 32 000: clear speech, little bandwidth). */
  readonly bitrate?: number;
  readonly media?: Pick<MediaDevices, 'getUserMedia'>;
}

interface Link {
  readonly pc: RTCPeerConnection;
  readonly transceiver: RTCRtpTransceiver | null;
  state: VoicePeer['state'];
  gain: GainNode | null;
  panner: StereoPannerNode | null;
  analyser: AnalyserNode | null;
  element: HTMLAudioElement | null;
  /** Candidates that arrived before the remote description. */
  readonly early: RTCIceCandidateInit[];
}

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) sum += v * v;
  // Speech RMS sits around 0.02–0.2: scale so ordinary talking reads 0.2–1.
  return Math.min(1, Math.sqrt(sum / buffer.length) * 5);
}

export class WebRtcVoice implements VoiceDevice {
  mic: MicState = 'off';
  readonly #options: WebRtcVoiceOptions;
  readonly #context: AudioContext;
  readonly #links = new Map<string, Link>();
  #outbox: VoiceSignal[] = [];
  #stream: MediaStream | null = null;
  #track: MediaStreamTrack | null = null;
  #analyser: AnalyserNode | null = null;
  #transmitting = false;
  readonly #buffer = new Float32Array(512);

  constructor(options: WebRtcVoiceOptions = {}) {
    this.#options = options;
    this.#context = options.context ?? new AudioContext();
  }

  openMic(): void {
    if (this.mic === 'live' || this.mic === 'requesting') return;
    const media = this.#options.media ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    if (media === undefined) {
      this.mic = 'unavailable';
      return;
    }
    this.mic = 'requesting';
    void this.#context.resume();
    media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then((stream) => {
      if (this.mic !== 'requesting') {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.#stream = stream;
      const track = stream.getAudioTracks()[0];
      if (track === undefined) {
        this.mic = 'unavailable';
        return;
      }
      // Peers get a clone that transmit() mutes; the level meter keeps listening to the original
      // (voice activity must hear the player while nothing is being sent).
      this.#track = track.clone();
      this.#track.enabled = this.#transmitting;
      const analyser = this.#context.createAnalyser();
      analyser.fftSize = 512;
      this.#context.createMediaStreamSource(stream).connect(analyser);
      this.#analyser = analyser;
      this.mic = 'live';
      for (const link of this.#links.values()) void link.transceiver?.sender.replaceTrack(this.#track);
    }, (error: unknown) => {
      this.mic = (error as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'unavailable';
    });
  }

  closeMic(): void {
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#track?.stop();
    for (const link of this.#links.values()) void link.transceiver?.sender.replaceTrack(null);
    this.#stream = null;
    this.#track = null;
    this.#analyser = null;
    this.mic = 'off';
  }

  micLevel(): number {
    return this.#analyser === null ? 0 : rms(this.#analyser, this.#buffer);
  }

  transmit(on: boolean): void {
    this.#transmitting = on;
    if (this.#track !== null) this.#track.enabled = on;
  }

  #signal(peer: string, body: object): void {
    this.#outbox.push({ peer, payload: JSON.stringify(body) });
  }

  #link(peer: string, initiator: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: this.#options.iceServers ?? [] });
    let transceiver: RTCRtpTransceiver | null = null;
    if (initiator) {
      transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.#preferOpus(transceiver);
      if (this.#track !== null) void transceiver.sender.replaceTrack(this.#track);
    }
    const link: Link = { pc, transceiver, state: 'connecting', gain: null, panner: null, analyser: null, element: null, early: [] };
    pc.onicecandidate = (e) => { if (e.candidate !== null) this.#signal(peer, { ice: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') link.state = 'open';
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') link.state = 'closed';
    };
    pc.ontrack = (e) => this.#hear(link, e.streams[0] ?? new MediaStream([e.track]));
    this.#links.set(peer, link);
    return link;
  }

  #preferOpus(transceiver: RTCRtpTransceiver): void {
    const capabilities = typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('audio') : null;
    if (capabilities === null || capabilities === undefined || typeof transceiver.setCodecPreferences !== 'function') return;
    const opus = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
    const rest = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/opus');
    if (opus.length > 0) transceiver.setCodecPreferences([...opus, ...rest]);
  }

  #hear(link: Link, stream: MediaStream): void {
    const element = document.createElement('audio');
    element.muted = true;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    const source = this.#context.createMediaStreamSource(stream);
    const analyser = this.#context.createAnalyser();
    analyser.fftSize = 512;
    const gain = this.#context.createGain();
    const panner = this.#context.createStereoPanner();
    source.connect(analyser);
    source.connect(gain).connect(panner).connect(this.#context.destination);
    Object.assign(link, { element, analyser, gain, panner });
  }

  connect(peer: string, initiator: boolean): void {
    if (this.#links.has(peer)) return;
    const link = this.#link(peer, initiator);
    if (!initiator) return;
    void (async () => {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      this.#limitBitrate(link);
      this.#signal(peer, { sdp: link.pc.localDescription!.toJSON() });
    })();
  }

  #limitBitrate(link: Link): void {
    const sender = link.transceiver?.sender ?? link.pc.getSenders()[0];
    if (sender === undefined) return;
    const parameters = sender.getParameters();
    parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((e) => ({ ...e, maxBitrate: this.#options.bitrate ?? 32000 }));
    void sender.setParameters(parameters).catch(() => undefined);
  }

  disconnect(peer: string): void {
    const link = this.#links.get(peer);
    if (link === undefined) return;
    link.pc.close();
    link.gain?.disconnect();
    link.panner?.disconnect();
    if (link.element !== null) link.element.srcObject = null;
    this.#links.delete(peer);
  }

  receiveSignal(signal: VoiceSignal): void {
    const link = this.#links.get(signal.peer);
    if (link === undefined) return;
    const message = JSON.parse(signal.payload) as { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
    void (async () => {
      if (message.sdp !== undefined) {
        await link.pc.setRemoteDescription(message.sdp);
        for (const c of link.early.splice(0)) await link.pc.addIceCandidate(c);
        if (message.sdp.type === 'offer') {
          const transceiver = link.pc.getTransceivers()[0];
          if (transceiver !== undefined) {
            transceiver.direction = 'sendrecv';
            this.#preferOpus(transceiver);
            (link as { transceiver: RTCRtpTransceiver | null }).transceiver = transceiver;
            if (this.#track !== null) await transceiver.sender.replaceTrack(this.#track);
          }
          await link.pc.setLocalDescription(await link.pc.createAnswer());
          this.#limitBitrate(link);
          this.#signal(signal.peer, { sdp: link.pc.localDescription!.toJSON() });
        }
      } else if (message.ice !== undefined) {
        if (link.pc.remoteDescription === null) link.early.push(message.ice);
        else await link.pc.addIceCandidate(message.ice);
      }
    })();
  }

  takeSignals(): VoiceSignal[] {
    const out = this.#outbox;
    this.#outbox = [];
    return out;
  }

  peers(): readonly VoicePeer[] {
    return [...this.#links].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, link]) => ({
      id, state: link.state, level: link.analyser === null ? 0 : rms(link.analyser, this.#buffer),
    }));
  }

  play(peer: string, playback: VoicePlayback): void {
    const link = this.#links.get(peer);
    if (link?.gain == null || link.panner === null) return;
    const now = this.#context.currentTime;
    link.gain.gain.setTargetAtTime(playback.gain, now, 0.05);
    link.panner.pan.setTargetAtTime(playback.pan, now, 0.05);
  }

  close(): void {
    for (const peer of [...this.#links.keys()]) this.disconnect(peer);
    this.closeMic();
  }
}
