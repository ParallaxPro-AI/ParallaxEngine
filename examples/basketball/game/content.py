"""The rules of the court (config) and two registries: the crews on the ladder and the
locker-room perks."""

from enum import Enum

from parallax import Color, ContentRef, Localized, SoundRef, config, content, field, record


@record
class BotStyle:
    """How a bot plays. Your running mate's is in its prefab; a crew's comes from the ladder."""

    shoot_range: float = field(7.2, unit="m")
    perfect_rate: float = field(0.3, min=0, max=1, doc="Chance a release lands in the green.")
    good_rate: float = field(0.5, min=0, max=1, doc="Chance it lands in the yellow.")
    skill: float = field(1, doc="Multiplies every make rate.")
    steal_chance: float = field(0.4, min=0, max=1)
    close_pressure: float = field(0.8, doc="Higher reaches in for steals more often.")
    pass_chance: float = field(0.4, min=0, max=1, doc="Willingness to swing the ball when covered.")


@content("crew")
class Crew:
    """One opponent on the season ladder. Both of its bots play this style."""

    name: Localized
    taunt: Localized
    color: Color
    speed: float = field(4.8, unit="m/s")
    style: BotStyle = field(BotStyle())


class Category(Enum):
    SHOOTING = "shooting"
    DEFENSE = "defense"
    CONDITIONING = "conditioning"
    PLAYMAKING = "playmaking"
    REBOUNDING = "rebounding"


@content("perk")
class Perk:
    """A locker-room card. Taking one stacks its numbers on you, your running mate and
    the ball as stat modifiers for the rest of the run (see ladder.apply_perk)."""

    name: Localized
    description: Localized
    category: Category
    max_stacks: int = field(2, min=1)
    green_low: float = field(0, doc="Moves the start of the meter's green window.")
    green_high: float = field(0, doc="Moves the end of the green window.")
    three_bonus: float = field(0, doc="Make rate added to your threes.")
    contest_relief: float = field(0, doc="Added to the contested multiplier on your shots.")
    clutch_bonus: float = field(0, doc="Make rate added to your shots late in a period.")
    steal_chance: float = field(0)
    steal_range: float = field(0, unit="m")
    steal_cooldown: float = field(0, unit="s")
    pickup_radius: float = field(0, unit="m", doc="Your reach on loose balls.")
    pass_speed: float = field(0, unit="m/s", doc="Added to every pass on the court, as in the original.")
    ally_make_bonus: float = field(0, doc="Make rate added to your running mate's shots.")
    speed: float = field(0, unit="m/s")
    stamina_max: float = field(0)
    stamina_regen: float = field(0, unit="1/s")


@config("court")
class CourtRules:
    """Street-ball rules: 2v2, two quarters, overtime until someone leads."""

    ladder: list[ContentRef[Crew]]
    offers: int = field(3)

    quarters: int = field(2)
    quarter_seconds: float = field(90, unit="s")
    intermission_seconds: float = field(4, unit="s")
    overtime_seconds: float = field(45, unit="s")
    shot_clock: float = field(20, unit="s")
    late_clock: float = field(4, unit="s", doc="Bots shoot regardless of coverage once the shot clock is this low.")

    two_points: int = field(2)
    three_points: int = field(3)
    three_point_distance: float = field(7.5, unit="m")
    max_shot_distance: float = field(18, unit="m")
    falloff_start: float = field(6, unit="m", doc="Make rate falls off linearly from here to max distance.")
    shot_flight_seconds: float = field(1.4, unit="s")
    green_rate: float = field(0.95)
    yellow_rate: float = field(0.42)
    miss_rate: float = field(0.06)
    min_rate: float = field(0.02)
    your_max_rate: float = field(0.98)
    bot_max_rate: float = field(0.85, doc="A bot never becomes automatic.")
    contest_range: float = field(2.2, unit="m")
    contest_penalty: float = field(0.45, doc="Make-rate multiplier with a defender this close.")
    clutch_window: float = field(25, unit="s")

    pass_range: float = field(28, unit="m")
    assist_window: float = field(3.5, unit="s")
    steal_range: float = field(1.6, unit="m")
    steal_chance: float = field(0.45, doc="Your base chance; bots use their own.")
    steal_cooldown: float = field(0.9, unit="s")
    min_steal_cooldown: float = field(0.2, unit="s")
    bot_steal_interval: float = field(3.2, unit="s", doc="Divided by a bot's close_pressure...")
    min_bot_steal_interval: float = field(1.9, unit="s", doc="...but never more often than this.")

    loose_ball_seconds: float = field(5, unit="s")
    pickup_radius: float = field(1.5, unit="m")
    rebound_spread: float = field(2.6, unit="m")
    rebound_out_bias: float = field(4.5, unit="m", doc="Misses carom this far out toward mid-court.")
    shooter_box_out: float = field(1.4, unit="s", doc="A bot can't take its own miss for this long.")

    inbound_start: float = field(14, unit="m", doc="After a reset the team with the ball starts this far off its own rim.")
    defense_reset: float = field(8, unit="m", doc="...and the other team this far.")
    lane_spacing: float = field(4.5, unit="m")

    arrival_radius: float = field(0.25, unit="m", doc="A running bot this close to its spot stops.")
    guard_standoff: float = field(1.3, unit="m", doc="Arm's length an on-ball defender keeps.")
    paint_depth: float = field(3.2, unit="m", doc="How far off the rim the off-ball defender sags.")
    open_spread: float = field(5.5, unit="m", doc="Where an off-ball teammate spaces to.")
    lane_width: float = field(2.5, unit="m")
    drive_depth: float = field(0.6, doc="Bots drive to this fraction of their shooting range.")
    min_drive_depth: float = field(2, unit="m")
    pass_urgency: float = field(3, doc="Scales pass_chance into a per-second chance.")

    court_half_length: float = field(21, unit="m")
    court_half_width: float = field(10, unit="m")


@config("sounds")
class Sounds:
    """The court's sounds: the template's own files (and its three announcer lines),
    served from the ParallaxPro asset store. Volumes: assets/audio.json, by the same URLs."""
    shot_make: SoundRef
    shot_miss: SoundRef
    bucket_fanfare: SoundRef = field(doc="Announcer line on every bucket.")
    pass_ball: SoundRef
    steal: SoundRef
    bounce: SoundRef = field(doc="Also the shot-clock violation.")
    quarter_end: SoundRef = field(doc="Announcer line at the end of a quarter and before overtime.")
    match_end: SoundRef = field(doc="Announcer line when the game is decided.")
    charge_start: SoundRef
    charge_release: SoundRef
