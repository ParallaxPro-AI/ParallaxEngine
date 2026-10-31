"""Hearts: what hitting a hazard costs, and praise for clearing one."""

from parallax import System, TriggerEntered, on, system
from parallax.combat import Health
from project import Assets, Scenes, Text

from game.components import Obstacle, Runner
from game.config import Canyon, Sounds
from game.content import Lane
from game.events import RunEnded
from game.resources import Run, running


@system("hits", scenes=[Scenes.canyon], when=running)
class Hits(System):
    """Touching a hazard costs a heart from the runner's `Health`, which then
    keeps it invulnerable for a blink. The last heart ends the run and names
    what got you. Hazards that scroll past the runner untouched earn a
    "Clean hop!" in the HUD."""

    @on(TriggerEntered, when=running, where=lambda e: e.entity.has(Obstacle) and e.target.has(Runner))
    def touched(self, ctx, event: TriggerEntered):
        health = event.target.get(Health)
        if health.damage(1, source=event.entity) == 0:
            return  # still blinking from the last hit
        kind = event.entity.get(Obstacle).kind
        event.entity.destroy()
        if health.dead:
            ctx.emit(RunEnded(won=False, killer=kind))
            return
        self.praise(ctx, ctx.text(Text.feedback_hearts_left, hearts=int(health.current)))
        ctx.audio.play(ctx.config(Sounds).crash)
        ctx.vfx.play(Assets.vfx.hit_shock, at=event.target, scale=0.5)  # the template's half-strength shock
        ctx.camera.main.shake(ctx.config(Canyon).hit_shake / 2)

    def update(self, ctx, dt):
        cfg = ctx.config(Canyon)
        line = cfg.runner_x - cfg.pass_margin
        for entity, obstacle in ctx.world.query(Obstacle):
            if not obstacle.passed and entity.transform.position.x < line:
                obstacle.passed = True
                clean = Text.feedback_clean_slide if obstacle.kind.data.lane is Lane.AIR else Text.feedback_clean_hop
                self.praise(ctx, ctx.text(clean))

    def praise(self, ctx, message: str):
        run = ctx.get(Run)
        run.feedback = message
        run.feedback_until = ctx.time.now + ctx.config(Canyon).praise_seconds
