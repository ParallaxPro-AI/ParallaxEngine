"""The guard gap: this game's health bar."""

from parallax import System, Vec3, on, system
from project import Assets, Scenes

from game.audio import Sounds, play
from game.components import Runner
from game.config import Rules
from game.events import ObstacleHit, RunEnded, Stumbled
from game.resources import Run, live


@system("chase", scenes=[Scenes.street], when=live)
class Chase(System):
    """The guard rides `guard_gap` metres behind you. Every hit you take (unless
    a shield eats it) shoves him `guard_catch_up` metres closer and makes you
    stumble; running clean lets the gap drift back. When it closes to
    `guard_catch` he has you: busted."""

    def update(self, ctx, dt):
        run = ctx.get(Run)
        recover = ctx.config(Rules).guard_recover + run.recover_bonus
        run.guard_gap = min(run.gap_max, run.guard_gap + recover * dt)

    @on(ObstacleHit, when=live)
    def hit(self, ctx, event: ObstacleHit):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        if run.shields > 0:
            run.shields -= 1
            play(ctx, ctx.config(Sounds).shield_break)
            ctx.vfx.play(Assets.vfx.sparks, at=event.at + Vec3(0, 0.5, 0), count=26)
            return
        run.guard_gap -= rules.guard_catch_up
        play(ctx, ctx.config(Sounds).hit)
        ctx.vfx.play(Assets.vfx.smoke, at=event.at + Vec3(0, 0.5, 0))
        ctx.camera.main.shake(0.4, 0.26)
        if run.guard_gap <= rules.guard_catch:
            ctx.emit(RunEnded(won=False))
        else:
            runner, _ = ctx.world.query(Runner).single()
            ctx.emit(Stumbled(entity=runner))
