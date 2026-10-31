/**
 * Layered (adaptive) music: a base track and stems that play sample-locked with it, each
 * audible once the music's intensity (0..1, `ctx.audio.intensity`) reaches its threshold —
 * calm exploration adds percussion at 0.4 and brass at 0.8 as a fight heats up.
 *
 * The engine decides each stem's target gain from the intensity and sends it with a fade;
 * the output ramps each gain linearly from where it is to the target over the fade. `rampGain`
 * is that ramp, for the engine's own model of what is heard now (`AudioEngine.musicGains`).
 */

export interface StemLayer {
  /** Audible once intensity >= this (0..1). */
  readonly at: number;
  /** Full-on gain (default 1). */
  readonly volume: number;
}

/** A stem's target gain at an intensity: its volume once reached, else 0 (the fade does the smoothing). */
export function layerGain(layer: StemLayer, intensity: number): number {
  return intensity + 1e-9 >= layer.at ? layer.volume : 0;
}

export function layerGains(layers: readonly StemLayer[], intensity: number): number[] {
  return layers.map((layer) => layerGain(layer, intensity));
}

/** A linear ramp from `from` to `to` over `fade` seconds, `elapsed` seconds in (fade 0: at once). */
export function rampGain(from: number, to: number, elapsed: number, fade: number): number {
  if (!(fade > 0) || elapsed >= fade) return to;
  return from + (to - from) * Math.max(0, elapsed) / fade;
}
