"""The run's clock: speed, distance, stages and the finish line."""

from parallax import ContentRef, Shape, System, on, system
from project import Scenes

from game.components import GroundTint
from game.config import Canyon, Sounds
from game.content import StageDef
from game.events import RunEnded, StageEntered
from game.resources import Run, running


def open_course(ctx):
    """Set the canyon scrolling at base speed in the current stage's colours.
    The title screen's backdrop is the same canyon, so it opens the same way."""
    run = ctx.get(Run)
    run.speed = ctx.config(Canyon).base_speed
    paint(ctx, run.stage)


def paint(ctx, stage: ContentRef[StageDef]):
    look = stage.data
    ctx.camera.main.background = look.sky
    for entity in ctx.world.query(tagged=GroundTint):
        entity.get(Shape).color = look.ground


@system("course", scenes=[Scenes.canyon], when=running)
class Course(System):
    """Owns the run's clock. The world speeds up toward the current stage's cap,
    distance is metres scrolled, and crossing into a new stage re-paints the
    canyon and tightens its rhythm. Reaching the goal wins a Journey; in Endless
    the final stage's cap keeps creeping up, so the run never plateaus."""

    def start(self, ctx):
        open_course(ctx)

    def update(self, ctx, dt):
        run = ctx.get(Run)
        run.speed = min(self.speed_cap(ctx, run), run.speed + run.stage.data.speed_ramp * dt)
        run.distance += run.speed * dt

        reached = [stage for stage in ctx.content(StageDef) if run.distance >= stage.data.from_distance][-1]
        if reached != run.stage:
            run.stage = reached
            ctx.emit(StageEntered(stage=reached))

        if not run.endless and run.distance >= ctx.config(Canyon).goal_distance:
            ctx.emit(RunEnded(won=True))

    @on(StageEntered)
    def entered(self, ctx, event: StageEntered):
        paint(ctx, event.stage)
        ctx.audio.play(ctx.config(Sounds).stage)
        ctx.get(Run).stage_at = ctx.time.now

    def speed_cap(self, ctx, run: Run) -> float:
        stage = run.stage.data
        if not run.endless or run.stage != ctx.content(StageDef)[-1]:
            return stage.speed_cap
        cfg = ctx.config(Canyon)
        past = (run.distance - stage.from_distance) / 100
        return min(cfg.endless_speed_cap, stage.speed_cap + cfg.endless_ramp_per_100m * past)
