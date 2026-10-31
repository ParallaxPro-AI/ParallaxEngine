from parallax import Context, System, on, system
from project import Assets

from game.config import Cue, Rules, Sounds
from game.events import (
    GemShattered, RelicPicked, RunEnded, StageCleared, SwapMade, SwapRejected, WaveCleared,
)


def play(ctx: Context, cue: Cue) -> None:
    ctx.audio.play(cue.sound, volume=cue.volume)


@system("feedback")
class Feedback(System):
    """Sound, particles and shake. Reacts to what the rules report and changes no game
    state, so the juice can be retuned without touching the rules. The cues are
    `config/sounds.json`; the board's music is the scene's, and it stops when a stage
    is cleared or the run ends (the next stage's load starts it again)."""

    @on(SwapMade)
    def swapped(self, ctx, event):
        play(ctx, ctx.config(Sounds).swap)

    @on(SwapRejected)
    def rejected(self, ctx, event):
        play(ctx, ctx.config(Sounds).swap)

    @on(GemShattered)
    def shattered(self, ctx, event):
        ctx.vfx.play(Assets.vfx.gem_burst, at=event.at, color=event.kind.data.color)

    @on(WaveCleared)
    def wave(self, ctx, event):
        rules = ctx.config(Rules)
        sounds = ctx.config(Sounds)
        play(ctx, sounds.match_clear)
        if event.chain > 1:
            play(ctx, sounds.cascade_chain)
        if event.forged:
            play(ctx, sounds.special_forged)
        if event.detonated:
            play(ctx, sounds.special_detonate)
        if event.crust:
            play(ctx, sounds.ice_break)
        if event.detonated or event.chain >= rules.shake_from_chain:
            ctx.camera.main.shake(min(rules.shake_max, rules.shake + rules.shake_per_chain * event.chain),
                                  rules.shake_seconds)

    @on(StageCleared)
    def stage_cleared(self, ctx, event):
        play(ctx, ctx.config(Sounds).stage_clear)
        ctx.audio.music(None)

    @on(RelicPicked)
    def relic(self, ctx, event):
        play(ctx, ctx.config(Sounds).relic_pick)

    @on(RunEnded)
    def ended(self, ctx, event):
        sounds = ctx.config(Sounds)
        play(ctx, sounds.win if event.won else sounds.lose)
        ctx.audio.music(None)
