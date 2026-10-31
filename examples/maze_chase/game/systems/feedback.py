from parallax import System, on, system
from project import Assets

from game.components import Gobbler
from game.config import Cue, Sounds
from game.events import GobblerCaught, LevelCleared, PipEaten, RunEnded, StalkerEaten


@system("feedback")
class Feedback(System):
    """Sounds, the flare burst and screen shake. The cues are `config/sounds.json`; the
    maze's music is declared by its scene and stops when the run ends."""

    @on(PipEaten)
    def pip_eaten(self, ctx, event: PipEaten):
        sounds = ctx.config(Sounds)
        if event.flare:
            play(ctx, sounds.flare)
            ctx.vfx.play(Assets.vfx.flare_burst, at=ctx.world.query(tagged=Gobbler).single())
        else:
            play(ctx, sounds.pip)

    @on(StalkerEaten)
    def stalker_eaten(self, ctx, event: StalkerEaten):
        play(ctx, ctx.config(Sounds).stalker_eaten)
        ctx.camera.main.shake(0.18, 0.16)

    @on(GobblerCaught)
    def caught(self, ctx, event: GobblerCaught):
        play(ctx, ctx.config(Sounds).caught)
        ctx.camera.main.shake(0.4, 0.3)

    @on(LevelCleared)
    def level_cleared(self, ctx, event: LevelCleared):
        play(ctx, ctx.config(Sounds).level_cleared)

    @on(RunEnded)
    def run_ended(self, ctx, event: RunEnded):
        sounds = ctx.config(Sounds)
        play(ctx, sounds.won if event.won else sounds.lost)
        ctx.audio.music(None)


def play(ctx, cue: Cue):
    ctx.audio.play(cue.sound, volume=cue.volume)
