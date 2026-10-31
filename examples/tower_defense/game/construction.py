"""Building, upgrading and selling towers against the gold in the purse. These are the
HUD's actions; the `Building` system calls the same functions for hotkeys and clicks.

Choosing a tower while an empty pad is selected builds it there at once; otherwise
the tower is armed and built on the next pad you pick."""

from parallax import Context, ContentRef, Entity
from project import Assets

from game.audio import Sounds
from game.components import Turret
from game.content import TowerDef
from game.events import TowerUpgraded
from game.resources import Build, Purse
from game.siege import sell_value, stats, tower_on


def choose_tower(ctx: Context, tower: ContentRef[TowerDef]) -> None:
    """Build `tower` on the selected empty pad, or arm it (toggle) for the next pad picked."""
    build = ctx.get(Build)
    if build.selected is not None and tower_on(build.selected) is None:
        build_on(ctx, build.selected, tower)
    else:
        build.armed = None if build.armed == tower else tower
        ctx.audio.play(ctx.config(Sounds).tower_arm, volume=0.25)


def cancel_build(ctx: Context) -> None:
    """Disarm the palette."""
    ctx.get(Build).armed = None


def build_on(ctx: Context, pad: Entity, tower: ContentRef[TowerDef]) -> None:
    """Pay for and raise `tower` on `pad`, unless it's taken or the purse is short."""
    purse = ctx.get(Purse)
    cost = stats(tower, 1).cost
    ctx.get(Build).armed = None
    if tower_on(pad) is not None or purse.gold < cost:
        ctx.audio.play(ctx.config(Sounds).build_blocked, volume=0.35)
        return
    purse.gold -= cost
    ctx.world.spawn(tower.data.prefab, parent=pad, components=[Turret(kind=tower)])
    ctx.vfx.play(Assets.vfx.build_dust, at=pad)
    ctx.audio.play(ctx.config(Sounds).tower_build, volume=0.5)


def upgrade_tower(ctx: Context) -> None:
    """Upgrade the tower on the selected pad, if it isn't maxed and the purse allows."""
    tower = selected_tower(ctx)
    turret = tower.get(Turret) if tower else None
    if turret is None or turret.level == len(turret.kind.data.levels):
        ctx.audio.play(ctx.config(Sounds).build_blocked, volume=0.3)
        return
    purse = ctx.get(Purse)
    cost = stats(turret.kind, turret.level + 1).cost
    if purse.gold < cost:
        ctx.audio.play(ctx.config(Sounds).build_blocked, volume=0.35)
        return
    purse.gold -= cost
    turret.level += 1
    ctx.emit(TowerUpgraded(tower=tower))
    ctx.vfx.play(Assets.vfx.upgrade_sparkle, at=tower)
    ctx.audio.play(ctx.config(Sounds).tower_upgrade, volume=0.5)


def sell_tower(ctx: Context) -> None:
    """Sell the tower on the selected pad for part of everything spent on it."""
    tower = selected_tower(ctx)
    if tower is None:
        return
    ctx.get(Purse).gold += sell_value(ctx, tower.get(Turret))
    tower.destroy()
    ctx.audio.play(ctx.config(Sounds).tower_sell, volume=0.5)


def selected_tower(ctx: Context) -> Entity | None:
    pad = ctx.get(Build).selected
    return tower_on(pad) if pad is not None else None
