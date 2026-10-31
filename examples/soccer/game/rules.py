"""Lookups shared by the systems, panels and playtests: this round, the two sides, the goals."""

from parallax import Context, Entity, Query, Tag, Vec3
from parallax.characters import Character
from project import Text

from game.components import Away, Footballer, Goal, Goalkeeper, Home
from game.content import CupRules, Opponent
from game.resources import Cup


def opponent(ctx: Context) -> Opponent:
    """The opponent of the round being played."""
    return ctx.config(CupRules).rounds[ctx.get(Cup).round].data


def team_of(player: Entity) -> Tag:
    return Home if player.has(Home) else Away


def rival(team: Tag) -> Tag:
    return Away if team is Home else Home


def outfield(ctx: Context, team: Tag) -> Query[Entity]:
    """A side's switchable players: everyone but the keeper."""
    return ctx.world.query(tagged=team, without=[Goalkeeper])


def goal_defended_by(ctx: Context, team: Tag) -> Entity:
    goal, _ = ctx.world.query(Goal).where(lambda entity, goal: goal.defended_by is team).single()
    return goal


def run_toward(ctx: Context, character: Character, target: Vec3, speed: float) -> None:
    """Run toward a point at `speed` m/s, and stop once there."""
    offset = (target - character.entity.transform.position).flat()
    if offset.length() < ctx.config(CupRules).arrival_radius:
        character.stop()
    else:
        character.move(offset, speed=speed)


def shirt(ctx: Context, player: Entity) -> str:
    """'#9 Striker': how the HUD and toasts name a home player."""
    footballer = player.get(Footballer)
    return ctx.text(Text.shirt, number=footballer.number, position=ctx.text(footballer.position))
