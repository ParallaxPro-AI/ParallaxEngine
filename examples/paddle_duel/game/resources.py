"""Game-wide state. Everything resets on retry (`new_run=True`) except `Best`."""

from parallax import ContentRef, field, resource

from game.content import PerkDef


@resource("run")
class Run:
    rival_index: int = field(0, min=0)
    score: int = field(0, min=0)
    rally: int = field(0, min=0, doc="Player returns since the last serve.")
    best_rally: int = field(0, min=0)
    won: bool = field(False)


@resource("duel")
class Duel:
    """The duel in progress. `Duels` resets it for every new rival."""
    player_points: int = field(0, min=0)
    rival_points: int = field(0, min=0)
    shields_used: int = field(0, min=0)
    serving: bool = field(True, doc="The ball sits on the centre spot, waiting to launch.")


@resource("mods")
class Mods:
    """The stacked effect of every perk drafted this run."""
    paddle_length: float = field(1.0)
    paddle_speed: float = field(1.0)
    english: float = field(1.0)
    charge_boost: float = field(1.0)
    charge_rate: float = field(1.0)
    rally_score: float = field(1.0)
    return_speed: float = field(1.0)
    ball_accel: float = field(1.0)
    shields: int = field(0)


@resource("draft")
class Draft:
    offer: list[ContentRef[PerkDef]] = field([], doc="Non-empty exactly while drafting.")
    owned: list[ContentRef[PerkDef]] = field([])


@resource("best", keep="profile")
class Best:
    score: int = field(0)
