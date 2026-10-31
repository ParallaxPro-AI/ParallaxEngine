from parallax import Shape, System, on, system
from parallax.combat import Died, Health
from parallax.grid import Grid
from project import Prefabs, Scenes

from game.components import Brick, Rail
from game.config import Rules
from game.events import StageCleared, StageStarted, UpgradePicked
from game.progress import current_stage, is_final_stage, lit
from game.resources import Run


@system("stages", scenes=[Scenes.arena])
class Stages(System):
    """Builds each stage's brick wall from its row pattern on the arena's wall grid,
    tints the rails in the stage colour, counts bricks down, and moves on to the next
    stage once an upgrade has been drafted."""

    def start(self, ctx):
        self.build(ctx)

    @on(UpgradePicked)
    def next_stage(self, ctx, event: UpgradePicked):
        ctx.get(Run).stage_index += 1
        self.build(ctx)

    @on(Died, where=lambda event: event.entity.has(Brick))
    def brick_broken(self, ctx, event: Died):
        run = ctx.get(Run)
        run.bricks_left -= 1
        if run.bricks_left == 0:
            ctx.emit(StageCleared(final=is_final_stage(ctx)))

    def build(self, ctx):
        stage = current_stage(ctx)
        for rail in ctx.world.query(tagged=Rail):
            rail.get(Shape).color = lit(stage.color, 1 - ctx.config(Rules).rail_shade)

        _, wall = ctx.world.query(Grid).single()
        count = 0
        for cell, symbol in wall.parse(stage.rows).items():
            if symbol.isdigit():
                hit_points = int(symbol)
                ctx.world.spawn(Prefabs.brick, at=wall.center(cell),
                                components=[Health(current=hit_points, max=hit_points)])
                count += 1

        run = ctx.get(Run)
        run.bricks_left = count
        ctx.emit(StageStarted(index=run.stage_index))
