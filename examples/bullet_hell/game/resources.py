"""Game-wide state. Everything resets on retry (`new_run=True`) except `Best`."""

from parallax import ContentRef, Timer, field, resource

from game.content import UpgradeDef


@resource("run")
class Run:
    wave_index: int = field(0, min=0)
    waves_cleared: int = field(0, min=0)
    score: int = field(0, min=0)
    graze: int = field(0, min=0)
    won: bool = field(False)
    new_best: bool = field(False)


@resource("spawner")
class Spawner:
    """The current wave's guardians entering one at a time."""
    sent: int = field(0, min=0, doc="Guardians sent so far; also the next one's formation slot.")
    cooldown: Timer = field(Timer.cooldown(0))


@resource("chain")
class Chain:
    """Kills close together climb a score multiplier; getting hurt drops it."""
    kills: int = field(0, min=0)
    window: Timer = field(Timer.cooldown(0), doc="The chain breaks when this runs out.")
    multiplier: int = field(1, min=1)


@resource("shrine")
class Shrine:
    offer: list[ContentRef[UpgradeDef]] = field([], doc="Non-empty exactly while the shrine is open.")
    taken: list[ContentRef[UpgradeDef]] = field([], doc="In order taken; repeats are stacks.")


@resource("best", keep="profile")
class Best:
    score: int = field(0)
    wave: int = field(0, doc="Furthest wave cleared.")
    graze: int = field(0)
    victories: int = field(0)
    runs: int = field(0)


@resource("banner")
class Banner:
    """The centre banner across the playfield strip (the HUD draws it): a wave or boss
    heading with its kicker, or one caps line (bloom labels, Spirit / Petal Bloom)."""
    kind: str = field("", doc="wave, warn, spirit, bloom, pickup or empty; styles the banner.")
    kick: str = field("", doc='The small line above a heading ("WAVE 3 —").')
    title: str = field("")
    timer: Timer = field(Timer.cooldown(0))
