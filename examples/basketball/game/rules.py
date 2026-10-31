"""Lookups shared by systems, behaviors, panels and playtests."""

from parallax import Context, Entity, Tag, Vec3
from parallax.characters import Character
from project import Placed

from game.components import Away, Ball, Home, Hoop
from game.content import CourtRules, Crew
from game.resources import Run


def crew(ctx: Context) -> Crew:
    """Tonight's opponent."""
    return ctx.config(CourtRules).ladder[ctx.get(Run).stage].data


def team_of(player: Entity) -> Tag:
    return Home if player.has(Home) else Away


def rival(team: Tag) -> Tag:
    return Away if team is Home else Home


def you(ctx: Context) -> Entity:
    return ctx.world.placed(Placed.you)


def teammates(ctx: Context, team: Tag) -> list[Entity]:
    return ctx.world.query(tagged=team).entities()


def hoop_defended_by(ctx: Context, team: Tag) -> Vec3:
    """The rim a team defends (and the other team attacks), at rim height."""
    entity, hoop = ctx.world.query(Hoop).where(lambda entity, hoop: hoop.defended_by is team).single()
    return entity.transform.position.with_y(hoop.rim_height)


def nearest_opponent_distance(ctx: Context, player: Entity) -> float:
    at = player.transform.position
    return at.distance_to(ctx.world.query(tagged=rival(team_of(player))).nearest(at).transform.position)


def give_ball(ctx: Context, player: Entity) -> None:
    """Hand possession to a baller and restart the shot clock."""
    _, ball = ctx.world.query(Ball).single()
    ball.holder = player
    ball.shot_clock = ctx.config(CourtRules).shot_clock


def run_to(ctx: Context, character: Character, target: Vec3) -> None:
    """Run flat-out toward a point, and stop once there."""
    offset = (target - character.entity.transform.position).flat()
    if offset.length() < ctx.config(CourtRules).arrival_radius:
        character.stop()
    else:
        character.move(offset.normalized())
