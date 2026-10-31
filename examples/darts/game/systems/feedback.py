from parallax import System, on, system
from project import Assets, Placed, Scenes

from game.config import Cue, Cues
from game.events import DartLanded, DartScored, DartThrown, LegStarted, LegWon, MatchEnded, SkillsScored
from game.resources import Match


def play(ctx, cue: Cue, scale: float = 1.0) -> None:
    ctx.audio.play(cue.sound, volume=cue.volume * scale)


def callout(ctx, label: str, points: int) -> None:
    """The HUD's toast under the strip (label + signed points), like the template's."""
    match = ctx.get(Match)
    match.callout = label
    match.callout_points = points
    match.callout_at = ctx.time.now


@system("feedback", scenes=[Scenes.oche_hall])
class Feedback(System):
    """Sound, shake, haptics, particles and the HUD callout for what happens at the
    oche. Listens to the game's events; the only state it writes is the callout.
    (The hall's music is the scene's `"music"`.)"""

    @on(LegStarted)
    def leg_started(self, ctx, event):
        play(ctx, ctx.config(Cues).ready)

    @on(DartThrown)
    def thrown(self, ctx, event: DartThrown):
        play(ctx, ctx.config(Cues).throw, 0.55 + 0.45 * event.power)
        ctx.camera.main.shake(0.05 + 0.05 * event.power, 0.09)
        ctx.input.rumble(0.3, 0.014)

    @on(DartLanded)
    def landed(self, ctx, event: DartLanded):
        if event.offset is not None:
            play(ctx, ctx.config(Cues).stick)
            ctx.vfx.play(Assets.vfx.board_dust, at=event.at)
            ctx.input.rumble(0.2, 0.01)

    @on(DartScored)
    def scored(self, ctx, event: DartScored):
        if event.penalty:
            callout(ctx, ctx.text(event.penalty.data.name), event.points)
            play(ctx, ctx.config(Cues).penalty)
            ctx.camera.main.shake(0.08, 0.12)

    @on(SkillsScored)
    def skills(self, ctx, event: SkillsScored):
        callout(ctx, " + ".join(ctx.text(skill.data.name) for skill in event.skills), event.points)
        play(ctx, ctx.config(Cues).skill)

    @on(LegWon)
    def leg_won(self, ctx, event):
        ctx.vfx.play(Assets.vfx.checkout_sparks, at=ctx.world.placed(Placed.board))
        ctx.camera.main.shake(0.14, 0.19)
        ctx.input.rumble(0.6, 0.032)
        play(ctx, ctx.config(Cues).checkout)

    @on(MatchEnded)
    def match_ended(self, ctx, event: MatchEnded):
        cues = ctx.config(Cues)
        play(ctx, cues.won if event.won else cues.missed)
