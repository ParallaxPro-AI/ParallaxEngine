"""Per-entity data: the ball, the footballers and the goals.

Fields marked `modifiable` are the ones team-talk training stacks bonuses on."""

from enum import Enum

from parallax import Entity, Localized, Tag, Vec3, component, field, tag

Home = tag("home")
"""Your club. Attacks the goal at +x."""

Away = tag("away")
"""The cup opponent. Attacks the goal at -x."""


class Effort(Enum):
    REST = "rest"
    RUN = "run"
    SPRINT = "sprint"


@component("ball")
class Ball:
    """Who has the match ball, and how it behaves at a dribbler's feet."""

    holder: Entity | None = field(None, doc="The player dribbling it; None while it rolls loose.")
    possession_lock: float = field(0, unit="s", doc="Possession can't change hands until this runs out.")
    kick_cooldown: float = field(0, unit="s", doc="Nobody can take or kick a ball struck this recently.")
    tackle_lock: float = field(0.8, unit="s", doc="How long possession sticks after it changes hands.")
    strike_cooldown: float = field(0.3, unit="s", doc="kick_cooldown set by every strike.")
    dribble_range: float = field(2.3, unit="m")
    kick_range: float = field(2.6, unit="m", doc="How close a player must be to shoot or pass.")
    carry_ahead: float = field(1.35, unit="m", doc="How far in front of the dribbler the ball is kept.")
    carry_pull: float = field(7, doc="Spring strength pulling the ball to that spot (1/s²).")


@component("footballer")
class Footballer:
    """One player: shirt, formation slot and how hard they run and kick."""

    number: int = field(0, doc="Shirt number.")
    position: Localized | None = field(None, doc="Shirt label shown on the HUD (home players).")
    short: Localized | None = field(None, doc="The position's initials on the HUD's shirt badge (CM, ST).")
    kickoff: Vec3 = field(Vec3.ZERO, doc="Formation slot. Taken from the scene placement at start.")
    ai_speed: float = field(6, unit="m/s", modifiable=True, doc="Running speed while the AI has this player.")
    kick_power: float = field(22, unit="m/s", modifiable=True)
    pass_power: float = field(15, unit="m/s", modifiable=True)
    pass_range: float = field(26, unit="m", modifiable=True)


@component("goalkeeper")
class Goalkeeper:
    """Marks a keeper (never switchable) and tunes how they guard the goal."""

    reach: float = field(6, unit="m", modifiable=True, doc="Comes off the line for loose balls this close.")
    box_depth: float = field(16, unit="m", doc="Only sweeps while the ball is this close to the goal line.")
    line_offset: float = field(2, unit="m", doc="Stands this far off the goal line.")
    save_speed: float = field(9, unit="m/s", doc="Smothering a ball faster than this counts as a save.")
    clear_spread: float = field(0.4, doc="Sideways share of a clearance, toward the near touchline.")


@component("stamina")
class Stamina:
    """The sprint tank. Only the player you control spends it."""

    current: float = field(100, min=0)
    max: float = field(100, min=1, modifiable=True)
    drain: float = field(22, unit="1/s", doc="Spent per second of sprinting.")
    regen: float = field(10, unit="1/s", modifiable=True, doc="Recovered per second while you jog.")
    rest_regen: float = field(22, unit="1/s", modifiable=True,
                              doc="Recovered per second standing still or off the ball.")
    floor: float = field(8, doc="An empty tank must refill past this before you can sprint again.")
    blown_pace: float = field(0.75, min=0, max=1, doc="Speed while the tank is empty.")
    blown: bool = field(False)
    effort: Effort = field(Effort.REST, doc="What the controlling player asked for this frame.")


@component("goal")
class Goal:
    """A goal frame. Its trigger collider sits just behind the line, inside the mouth."""

    defended_by: Tag = field(doc="The side that concedes when the ball enters.")
    mouth_half_width: float = field(2.6, unit="m")
