"""Match helpers shared by systems, behaviors and panels."""

from parallax import Context, ContentRef, Entity
from parallax.combat import Health
from project import Prefabs

from game.components import Arsenal, Bot, Fighter, Plating, Player, SpawnPoint
from game.config import MatchRules
from game.content import AmmoGrant, BotDef, RoundDef
from game.resources import Match, Mods, Phase


def fighting(ctx: Context) -> bool:
    """A round is under way (not between rounds, not over)."""
    return ctx.get(Match).phase is Phase.FIGHTING


def current_round(ctx: Context) -> RoundDef:
    return ctx.content(RoundDef)[ctx.get(Match).round].data


def player(ctx: Context) -> Entity:
    return ctx.world.query(tagged=Player).single()


def safest_spawn_point(ctx: Context) -> Entity:
    """The spawn point farthest from every bot."""
    bots = ctx.world.query(Bot).entities()
    return max(
        ctx.world.query(tagged=SpawnPoint),
        key=lambda point: min((point.transform.position.distance_to(b.transform.position) for b in bots), default=0),
    )


def spawn_bot(ctx: Context, bot: ContentRef[BotDef], name: str) -> Entity:
    """A bot of this archetype at the spawn point farthest from the player."""
    health = bot.data.health * ctx.get(Mods).bot_health_mul
    you = player(ctx).transform.position
    point = max(ctx.world.query(tagged=SpawnPoint), key=lambda p: p.transform.position.distance_to(you))
    return ctx.world.spawn(
        Prefabs.bot,
        at=point.transform.position,
        name=name,
        components=[Bot(kind=bot), Fighter(name=name), Health(current=health, max=health)],
    )


def restock(arsenal: Arsenal) -> None:
    """Full magazines and the starting reserve for every weapon carried."""
    for weapon in arsenal.weapons:
        arsenal.loaded[weapon] = weapon.data.magazine
        arsenal.reserve[weapon] = weapon.data.reserve
    arsenal.reload_done_at = -1


def give_ammo(arsenal: Arsenal, grants: list[AmmoGrant]) -> None:
    """Add spare rounds, up to each weapon's carrying limit."""
    for grant in grants:
        arsenal.reserve[grant.weapon] = min(grant.weapon.data.max_reserve, arsenal.reserve[grant.weapon] + grant.rounds)


def give_armor(ctx: Context, entity: Entity, points: float) -> None:
    """Add plating, up to the match's armor cap."""
    plating = entity.get(Plating)
    plating.points = min(ctx.config(MatchRules).armor_max, plating.points + points)
