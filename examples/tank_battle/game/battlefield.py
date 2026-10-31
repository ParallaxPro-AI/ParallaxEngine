"""Shared battlefield helpers."""

import math

from parallax import Context, Entity, Vec3, deg, heading_to
from project import Assets

from game.components import Explosive
from game.config import BattleRules
from game.content import BattlefieldDef
from game.events import DrumLit
from game.resources import Campaign


def current_battlefield(ctx: Context) -> BattlefieldDef:
    return ctx.get(Campaign).battlefield.data


def view_angles(ctx: Context) -> tuple[float, float]:
    """Yaw and pitch (up positive) of the chase camera's view: where the player is aiming."""
    _, view = ctx.camera.main.ray()
    return heading_to(Vec3.ZERO, view), deg(math.asin(view.y))


def ground_y(ctx: Context, point: Vec3) -> float:
    """Terrain height under the point, 0 off the terrain."""
    return ctx.terrain.height_at(point) if ctx.terrain.contains(point) else 0.0


def shell_burst(ctx: Context, point: Vec3, *, source: Entity | None = None, size: str = "small") -> None:
    """Every shell that lands somewhere (a hit, a miss in the dirt, a wall) bursts there,
    and cooks off any fuel drum within the trigger radius, whoever fired it."""
    ctx.vfx.play(Assets.vfx.shell_burst if size == "small" else Assets.vfx.tank_explosion, at=point)
    radius = ctx.config(BattleRules).drum_trigger_radius
    for drum in ctx.world.query(tagged=Explosive).near(point, radius).entities():
        ctx.emit(DrumLit(drum=drum, by=source))
