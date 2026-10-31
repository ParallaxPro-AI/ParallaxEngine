from parallax import Color, System, on, system
from project import Assets

from game.audio import Sounds, play
from game.components import Smash
from game.events import BallReturned, DuelWon, PerkPicked, RallyEnded, RunEnded, WallHit

WALL_SPARK = Color.hex("#b3b3cc")
SMASH_SPARK = Color.hex("#ffe659")
POINT_SPARK = Color.hex("#66ffb3")
SHIELD_SPARK = Color.hex("#99e6ff")
CONCEDE_SPARK = Color.hex("#ff6666")
PLAYER_RETURN_SPARK = Color.hex("#73bfff")
RIVAL_RETURN_SPARK = Color.hex("#ff7373")


@system("feedback")
class Feedback(System):
    """Hit sounds, sparks, shake and rumble. The arena's music is declared by its
    scene; the cues and their volumes are config/audio.json."""

    @on(WallHit)
    def wall_hit(self, ctx, event: WallHit):
        play(ctx, ctx.config(Sounds).wall_click)
        ctx.vfx.play(Assets.vfx.wall_sparks, at=event.at, color=WALL_SPARK)

    @on(BallReturned)
    def returned(self, ctx, event: BallReturned):
        if event.smashed:
            play(ctx, ctx.config(Sounds).smash_zap)
            ctx.camera.main.shake(0.35, 0.14)
            ctx.input.rumble(0.8, 0.028)
            ctx.vfx.play(Assets.vfx.smash_sparks, at=event.source, color=SMASH_SPARK)
            return
        play(ctx, ctx.config(Sounds).paddle_ping)
        if event.source.has(Smash):
            ctx.vfx.play(Assets.vfx.sparks, at=event.source, color=PLAYER_RETURN_SPARK)
            ctx.input.rumble(0.4, 0.012)
        else:
            ctx.vfx.play(Assets.vfx.sparks, at=event.source, color=RIVAL_RETURN_SPARK)

    @on(RallyEnded)
    def rally_ended(self, ctx, event: RallyEnded):
        if event.player_scored:
            play(ctx, ctx.config(Sounds).point_chime)
            ctx.vfx.play(Assets.vfx.point_sparks, at=event.at, color=POINT_SPARK)
        elif event.refunded:
            play(ctx, ctx.config(Sounds).second_wind)
            ctx.vfx.play(Assets.vfx.goal_sparks, at=event.at, color=SHIELD_SPARK)
        else:
            play(ctx, ctx.config(Sounds).concede)
            ctx.camera.main.shake(0.5, 0.22)
            ctx.vfx.play(Assets.vfx.goal_sparks, at=event.at, color=CONCEDE_SPARK, count=16)

    @on(DuelWon, where=lambda event: not event.final)
    def duel_won(self, ctx, event: DuelWon):
        play(ctx, ctx.config(Sounds).duel_won)

    @on(PerkPicked)
    def perk_picked(self, ctx, event: PerkPicked):
        play(ctx, ctx.config(Sounds).perk)

    @on(RunEnded)
    def run_ended(self, ctx, event: RunEnded):
        sounds = ctx.config(Sounds)
        play(ctx, sounds.victory if event.won else sounds.defeat)
