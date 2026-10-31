"""Game-wide state: the race on this track, the last result, and the career and season
that persist on the device."""

from enum import Enum

from parallax import ContentRef, field, record, resource
from project import Content

from game.content import CarDef, DifficultyDef, RoundDef, TimeOfDayDef, TrackDef, WeatherDef


class RacePhase(Enum):
    GRID = "grid"
    COUNTDOWN = "countdown"
    RACING = "racing"
    FINISHED = "finished"


@resource("race_plan")
class RacePlan:
    """What the title and the garage picked for the next race. A championship round
    overrides everything here but the car and the difficulty (see rules.race_terms)."""
    championship: bool = field(False, doc="False: a quick race on the settings below.")
    track: ContentRef[TrackDef] = field(Content.track.terrain_sprint)
    laps: int = field(3, min=1)
    opponents: int = field(3, min=1, max=3)
    weather: ContentRef[WeatherDef] = field(Content.weather.clear)
    time_of_day: ContentRef[TimeOfDayDef] = field(Content.time_of_day.sunset)


@resource("race", keep="scene")
class Race:
    """The race on the loaded track, its terms fixed when the grid is built. Starts over
    on every scene load."""
    phase: RacePhase = field(RacePhase.GRID)
    round: ContentRef[RoundDef] | None = field(None, doc="The championship round being run; None: a quick race.")
    track: ContentRef[TrackDef] = field(Content.track.terrain_sprint)
    laps: int = field(3, min=1)
    opponents: int = field(3, min=1, max=3)
    weather: ContentRef[WeatherDef] = field(Content.weather.clear)
    time_of_day: ContentRef[TimeOfDayDef] = field(Content.time_of_day.sunset)
    started_at: float = field(0, unit="s", doc="Game time when the lights went green.")
    ghost_best: float = field(-1, unit="s", doc="The ghost's race time (best on this track at these laps); -1: no ghost yet.")


@record
class ResultRow:
    car: ContentRef[CarDef] = field()
    is_player: bool = field(False)
    finished: bool = field(False)
    time: float = field(0, unit="s")
    points: int = field(0)


@record
class StandingRow:
    car: ContentRef[CarDef] = field()
    is_player: bool = field(False)
    points: int = field(0)


@resource("race_result")
class RaceResult:
    """What the results screen shows. Written once when the player crosses the line."""
    place: int = field(0)
    rows: list[ResultRow] = field([])
    standings: list[StandingRow] = field([])
    credits_earned: int = field(0)
    lap_record: bool = field(False)
    race_time: float = field(0, unit="s")
    best_lap: float = field(0, unit="s")
    championship: bool = field(False)
    has_next_round: bool = field(False)
    season_over: bool = field(False)
    champion: bool = field(False)


@resource("career", keep="profile")
class Career:
    """Everything the garage remembers between sessions."""
    credits: int = field(1200)
    car: ContentRef[CarDef] = field(Content.car.bolt)
    purchased_cars: list[ContentRef[CarDef]] = field([])
    part_tiers: dict[str, int] = field({}, doc="Part id -> tier index bought.")
    difficulty: ContentRef[DifficultyDef] = field(Content.difficulty.normal)
    best_laps: dict[str, float] = field({}, doc="Track id -> seconds.")
    titles: int = field(0)


@resource("season", keep="profile")
class Season:
    """The championship in progress. Points are keyed by `standings_key`."""
    round: int = field(0, doc="Index into the round calendar.")
    points: dict[str, int] = field({})


@resource("garage_menu", keep="scene")
class GarageMenu:
    """Which of the template's pre-race screens is up (car, garage, track, settings) and
    the car the arrows are showing, which may be one you don't own yet."""
    screen: str = field("car")
    shown: ContentRef[CarDef] | None = field(None, doc="None: the career's car.")
