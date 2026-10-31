"""Read-only helpers: rank and upgrade effects, and where things are."""

from parallax import Context, ContentRef, Entity, Vec3
from parallax.characters import Character

from game.components import Depot, Pilot, Plane
from game.config import FreightRules
from game.content import IslandDef, RankDef, UpgradeDef, UpgradeStat
from game.resources import Board, Career


def rank(ctx: Context) -> ContentRef[RankDef]:
    """The highest rung the delivery count has reached."""
    deliveries = ctx.get(Career).deliveries
    return ctx.content(RankDef).where(lambda rung: rung.deliveries <= deliveries)[-1]


def reached(ctx: Context, rung: ContentRef[RankDef] | None) -> bool:
    return rung is None or rung.data.deliveries <= ctx.get(Career).deliveries


def upgrade_total(ctx: Context, stat: UpgradeStat) -> float:
    """What every tier bought of upgrades with this stat adds up to."""
    tiers = ctx.get(Career).upgrades
    return sum(u.data.per_tier * tiers.get(u.id, 0) for u in ctx.content(UpgradeDef) if u.data.stat is stat)


def pay_multiplier(ctx: Context) -> float:
    return rank(ctx).data.pay_bonus * (1 + upgrade_total(ctx, UpgradeStat.PAY))


def airframes_left(ctx: Context) -> int:
    bought = int(upgrade_total(ctx, UpgradeStat.AIRFRAME))
    return ctx.config(FreightRules).start_airframes + bought - ctx.get(Career).airframes_lost


def upgrade_price(ctx: Context, upgrade: ContentRef[UpgradeDef]) -> int | None:
    """The next tier's price, or None when it can't be bought (maxed, or the hangar is full)."""
    if upgrade.data.stat is UpgradeStat.AIRFRAME:
        return upgrade.data.costs[0] if airframes_left(ctx) < ctx.config(FreightRules).max_airframes else None
    tier = ctx.get(Career).upgrades.get(upgrade.id, 0)
    return upgrade.data.costs[tier] if tier < len(upgrade.data.costs) else None


def depot(ctx: Context, island: ContentRef[IslandDef]) -> Entity:
    return ctx.world.query(Depot).where(lambda _, pad: pad.island == island).single()[0]


def depot_near(ctx: Context, point: Vec3, radius: float) -> ContentRef[IslandDef] | None:
    row = ctx.world.query(Depot).near(point, radius).nearest(point)
    return row[1].island if row else None


def pilot(ctx: Context) -> Entity:
    return ctx.world.query(tagged=Pilot).single()


def flown(ctx: Context) -> Entity | None:
    """The plane the pilot is sitting in, if any. Every island has one parked."""
    return pilot(ctx).get(Character).vehicle


def at_the_controls(ctx: Context) -> bool:
    """Whether the pilot is in the cockpit."""
    return flown(ctx) is not None


def interactor(ctx: Context) -> Entity:
    """What loads, unloads and visits the office: the plane while flying it, else the pilot."""
    return flown(ctx) or pilot(ctx)


def plane_in_reach(ctx: Context) -> Entity | None:
    """The nearest parked plane the pilot on foot can board."""
    here = pilot(ctx).transform.position
    return ctx.world.query(tagged=Plane).near(here, ctx.config(FreightRules).board_reach).nearest(here)


def distance_text(metres: float) -> str:
    """The template's distances: metres up to a kilometre, then tenths of a kilometre."""
    return f"{round(metres / 100) / 10} km" if metres >= 1000 else f"{round(metres)} m"


def money(amount: float) -> str:
    return f"${round(amount):,}"


def objective(ctx: Context) -> ContentRef[IslandDef] | None:
    """The island the current job points at: its origin until loaded, then its destination."""
    board = ctx.get(Board)
    if board.contract is None:
        return None
    return board.contract.destination if board.loaded else board.contract.origin
