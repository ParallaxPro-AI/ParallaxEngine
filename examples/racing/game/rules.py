"""Read-only helpers over the career, the season and the race."""

from parallax import Context, ContentRef, Entity, Vec3
from parallax.physics import Rigidbody

from game.components import PlayerCar, Racer, RacingLine
from game.config import RaceRules
from game.content import CarDef, PartDef, PartTier, RoundDef
from game.resources import Career, Race, RacePhase, RacePlan, Season
from game.track import pose_before_gate


def current_round(ctx: Context) -> ContentRef[RoundDef]:
    return ctx.content(RoundDef)[ctx.get(Season).round]


def settle_terms(ctx: Context) -> None:
    """Fix the race's terms when its grid is built: a championship round forces the
    track, laps, field, weather and hour; a quick race takes the garage's picks."""
    plan, race = ctx.get(RacePlan), ctx.get(Race)
    if plan.championship:
        round_ = current_round(ctx)
        race.round = round_
        race.track, race.laps, race.opponents = round_.data.track, round_.data.laps, round_.data.opponents
        race.weather, race.time_of_day = round_.data.weather, round_.data.time_of_day
    else:
        race.round = None
        race.track, race.laps, race.opponents = plan.track, plan.laps, plan.opponents
        race.weather, race.time_of_day = plan.weather, plan.time_of_day


def next_track(ctx: Context):
    """The scene the garage's Race button loads: the round's track, or the picked one."""
    plan = ctx.get(RacePlan)
    track = current_round(ctx).data.track if plan.championship else plan.track
    return track.data.scene


def owns(ctx: Context, car: ContentRef[CarDef]) -> bool:
    return car.data.price == 0 or car in ctx.get(Career).purchased_cars


def installed_tier(ctx: Context, part: ContentRef[PartDef]) -> PartTier:
    return part.data.tiers[ctx.get(Career).part_tiers.get(part.id, 0)]


def standings_key(car: Entity) -> str:
    """Championship points belong to "player", or to the rival car's content id."""
    return "player" if car.has(PlayerCar) else car.get(Racer).car.id


def racing_line(ctx: Context) -> RacingLine:
    _, line = ctx.world.query(RacingLine).single()
    return line


def is_racing(ctx: Context) -> bool:
    """The lights are green and the player hasn't finished. Every driver's update hook
    runs only while this holds, so cars sit still on the grid and in the countdown."""
    return ctx.get(Race).phase is RacePhase.RACING


def on_the_ground(ctx: Context, point: Vec3) -> Vec3:
    """Where to place a car so it drops onto the terrain under `point`."""
    return ctx.terrain.ground(point) + Vec3(0, ctx.config(RaceRules).spawn_height, 0)


def put_back_on_track(ctx: Context, car: Entity) -> None:
    """The car back on the racing line, upright, short of the gate it was heading for."""
    back = ctx.config(RaceRules).respawn_before_gate
    point, yaw = pose_before_gate(racing_line(ctx), car.get(Racer).gates_passed, back)
    car.get(Rigidbody).teleport(on_the_ground(ctx, point), rotation=Vec3(0, yaw, 0))
