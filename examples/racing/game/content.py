"""Content registries: the car roster, tracks, weather, the championship calendar,
garage parts and difficulty levels. Text fields are `Localized`: written inline in each
entry's JSON and extracted for translators by the toolchain."""

from parallax import ContentRef, Localized, PrefabRef, SceneRef, content, field, record


@content("car")
class CarDef:
    """A car on the roster. Simulation tuning lives on the prefab's Vehicle; the stats
    here are the 0-150 bars the garage draws."""
    name: Localized = field()
    blurb: Localized = field()
    prefab: PrefabRef = field()
    showroom: PrefabRef = field(doc="The model alone, standing in the garage lineup.")
    top_speed: int = field(min=0)
    acceleration: int = field(min=0)
    handling: int = field(min=0)
    price: int = field(0, min=0, doc="0 = owned from the start.")


@content("track", order="order")
class TrackDef:
    """A circuit. Its scene carries the `track` scene tag, which is what brings the race
    systems into it."""
    name: Localized = field()
    blurb: Localized = field()
    scene: SceneRef = field()
    difficulty: str = field("easy", doc="easy, medium or hard: the map card's chip.")
    laps: int = field(3, min=1, doc="The default laps on the map card.")
    order: int = field(0)


@content("weather", order="order")
class WeatherDef:
    """Race weather: a preset of the weather plugin. The plugin greys the sky, brings the
    rain and lightning, and wets the road, and the vehicles plugin reads its
    `ctx.weather.friction` every step, so a wet road cuts every car's grip by itself."""
    name: Localized = field()
    preset: str = field(doc="Weather plugin preset: clear, rain, storm, snow, ...")
    order: int = field(0)


@content("time_of_day", order="order")
class TimeOfDayDef:
    """An hour a race can be run at."""
    name: Localized = field()
    hour: float = field(12, min=0, max=24, unit="h")
    order: int = field(0)


@content("round", order="number")
class RoundDef:
    """One championship round. The round forces the track, the laps, the field size,
    the weather and the hour; only the difficulty stays the player's."""
    name: Localized = field()
    blurb: Localized = field()
    conditions: Localized = field(doc="How the weather and light read on the round card.")
    number: int = field(min=1)
    track: ContentRef[TrackDef] = field()
    laps: int = field(3, min=1)
    opponents: int = field(3, min=1, max=3)
    weather: ContentRef[WeatherDef] = field()
    time_of_day: ContentRef[TimeOfDayDef] = field()
    purse_scale: float = field(1, min=0)
    points_scale: int = field(1, min=1)


@record
class PartTier:
    """One tier of a garage part. Every multiplier defaults to 1 (no effect); they are
    stacked on the car as stat modifiers keyed by the part's id."""
    name: Localized = field()
    blurb: Localized = field("", doc="What the tier does, on its garage card.")
    price: int = field(0, min=0)
    torque: float = field(1)
    top_speed: float = field(1)
    grip: float = field(1)
    brake: float = field(1)
    nitro_capacity: float = field(1)
    nitro_gain: float = field(1)


@content("part", order="order")
class PartDef:
    """A garage part. Tiers are bought in order and apply to whichever car you drive."""
    name: Localized = field()
    blurb: Localized = field()
    tiers: list[PartTier] = field()
    order: int = field(0, doc="Its place on the garage shelf.")


@content("difficulty", order="ai_speed_scale")
class DifficultyDef:
    """How fast the rivals drive, and how much the purse pays for beating them."""
    name: Localized = field()
    ai_speed_scale: float = field(1, min=0.1)
    payout_scale: float = field(1, min=0)
