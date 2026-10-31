from parallax import Behavior, TextRef, Vec3, behavior, on, param
from parallax.combat import Health
from parallax.voxels import Cell3, VoxelBlock
from project import Text

from features.survival.components import Vitals
from features.survival.events import HomeSet, Slept
from features.survival.home import is_open
from features.survival.resources import Run
from game.components import Hostile
from game.config import Rules
from game.events import Used
from game.world import day_number

SIDES = (Cell3(1, 0, 0), Cell3(-1, 0, 0), Cell3(0, 0, 1), Cell3(0, 0, -1))


@behavior("bed", requires=[VoxelBlock])
class Bed(Behavior):
    """Using a bed makes it home, where you wake after dying. At night, under a
    roof and with nothing hostile able to reach it, it also sleeps you through to
    the next morning."""

    roof_height: float = param(8, unit="m", doc="A roof must be within this distance above the bed.")

    @on(Used)
    def used(self, ctx, event: Used):
        cell = self.entity.get(VoxelBlock).cell
        bedside = self._bedside(ctx, cell)
        if bedside is None:
            ctx.ui.toast(Text.bed_needs_floor)
            return
        ctx.get(Run).home = bedside
        ctx.emit(HomeSet(by=event.by))
        reason = self._cannot_sleep(ctx, cell)
        if reason:
            ctx.ui.toast(reason)
            return
        rules = ctx.config(Rules)
        event.by.get(Health).heal(rules.sleep_heal)
        vitals = event.by.get(Vitals)
        vitals.hunger = max(0.0, vitals.hunger - rules.sleep_hunger)
        ctx.environment.day += 1
        ctx.environment.time_of_day = rules.wake_hour
        ctx.ui.announce(Text.new_day, ctx.text(Text.day_number, day=day_number(ctx)))
        ctx.emit(Slept(by=event.by))

    def _bedside(self, ctx, cell: Cell3) -> Vec3 | None:
        """The first open floor tile beside the bed."""
        for side in SIDES:
            feet = cell + side
            if is_open(ctx, feet) and is_open(ctx, feet + Cell3.UP) and not is_open(ctx, feet + Cell3.DOWN):
                return feet.center().with_y(feet.y + 0.05)
        return None

    def _cannot_sleep(self, ctx, cell: Cell3) -> TextRef | None:
        here = cell.center()
        if not ctx.voxels.raycast(here, Vec3.UP, self.roof_height):
            return Text.home_set_build_roof
        if not ctx.environment.is_night:
            return Text.home_set_sleep_at_night
        threats = ctx.world.query(tagged=Hostile).near(here, ctx.config(Rules).sleep_threat_radius)
        if threats.where(lambda mob: _in_sight(ctx, here, mob.transform.position)).count():
            return Text.threat_near_bed
        return None


def _in_sight(ctx, a: Vec3, b: Vec3) -> bool:
    gap = b - a
    return ctx.voxels.raycast(a, gap.normalized(), gap.length()) is None
