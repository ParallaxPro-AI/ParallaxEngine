"""Every number the run is made of (config/rules.json), and the questions about the run
that several modules ask."""

from parallax import Context, Entity, SoundRef, config, field, record
from project import Placed

from game.resources import Choices, Records, Run


@record
class Scales:
    """How hard the horde is and how much a run pays, relative to a normal run."""
    hp: float = field(1)
    speed: float = field(1)
    count: float = field(1)
    score: float = field(1)


@record
class Cue:
    """One sound from the hosted asset library and the level it plays at."""
    sound: SoundRef = field()
    volume: float = field(1, min=0)


@record
class Sounds:
    """Every cue the template's audio map names, by what it marks."""
    bolt: Cue = field(doc="The staff fires (twice a second, so quiet).")
    spit: Cue = field(doc="A spitter throws a cinder shard.")
    kill: Cue = field(doc="A body dissolves (throttled).")
    mote: Cue = field(doc="A soul mote is collected.")
    heart: Cue = field(doc="An ember heart heals.")
    level_up: Cue = field()
    draft: Cue = field(doc="A draft card is taken.")
    reroll: Cue = field(doc="The draft redeals.")
    denied: Cue = field(doc="No rerolls left, or not enough dust.")
    buy: Cue = field(doc="A shrine perk is bought.")
    nova: Cue = field()
    hurt: Cue = field()
    warden: Cue = field(doc="An Ash Warden walks in.")
    rekindle: Cue = field(doc="Second Wind relights the ember.")
    win: Cue = field(doc="The circle holds.")
    lose: Cue = field(doc="The ember goes out.")


@config("rules")
class Rules:
    """The arena, the escalation, scoring, the payout and the Vigil."""
    run_seconds: float = field(180, unit="s")
    arena_radius: float = field(58, unit="m")
    wall_margin: float = field(3, unit="m", doc="Surges never appear closer than this to the wall.")
    max_enemies: int = field(430, doc="The horde ceiling.")
    spawn_ring: tuple[float, float] = field((34, 52), unit="m", doc="Surges arrive this far from the survivor.")
    cluster_radius: float = field(7, unit="m")
    cluster_spacing: float = field(1.6, unit="m")
    heat_frequency: float = field(0.02)
    heat_octaves: int = field(3)
    heat_candidates: int = field(7, doc="Points sampled around the ring; the hottest sends the surge.")
    hot_bonus: float = field(0.6, doc="A fully hot sector sends this much more of each group.")

    base_xp_to_level: float = field(8)
    xp_growth: float = field(1.28)
    draft_choices: int = field(3)
    rerolls_per_run: int = field(1)

    combo_window: float = field(2.4, unit="s")
    combo_per_kill: float = field(0.04)
    combo_max: float = field(3)
    kill_points: float = field(10)
    survive_points: float = field(4, doc="Per second survived.")
    level_points: float = field(60)
    heart_heal_pct: float = field(0.22)

    dust_per_hundred_score: float = field(1)
    dust_per_level: float = field(2)
    dust_on_survive: float = field(40)

    vigil_unlock_after: int = field(1, doc="Survived runs before Ashen Vigil unlocks.")
    vigil: Scales = field(Scales(), doc="The Ashen Vigil's horde and payout.")

    second_wind_health: float = field(0.5, doc="Fraction of max health a rekindle restores.")
    second_wind_mercy: float = field(2.5, unit="s")
    second_wind_radius: float = field(12, unit="m", doc="Minimum blast radius of a rekindle.")
    nova_knockback: float = field(9, unit="m")
    min_fire_interval: float = field(0.08, unit="s")
    min_nova_cooldown: float = field(2, unit="s")

    kill_fx_interval: float = field(0.12, unit="s", doc="At most one burst of kill sparks this often.")
    kill_sound_interval: float = field(0.22, unit="s", doc="At most one kill sound this often.")
    alert_seconds: float = field(2.4, unit="s", doc="How long a HUD banner stays up.")
    entrance_alert_seconds: float = field(2.6, unit="s")
    dissolve_seconds: float = field(1.6, unit="s", doc="The Emberwarden burns in at the start and out at the end.")

    sounds: Sounds = field()


def survivor(ctx: Context) -> Entity:
    return ctx.world.placed(Placed.survivor)


def run_live(ctx: Context) -> bool:
    """The run is still undecided (a run condition for the arena's systems)."""
    return ctx.get(Run).outcome is None


def vigil_unlocked(ctx: Context) -> bool:
    return ctx.get(Records).runs_survived >= ctx.config(Rules).vigil_unlock_after


def scales(ctx: Context) -> Scales:
    """The Ashen Vigil's multipliers during a Vigil run, otherwise all 1."""
    return ctx.config(Rules).vigil if ctx.get(Choices).vigil else Scales()


def xp_to_level(ctx: Context) -> float:
    """XP needed for the next level; each level asks `xp_growth` times more."""
    rules = ctx.config(Rules)
    return rules.base_xp_to_level * rules.xp_growth ** (ctx.get(Run).level - 1)


def play(ctx: Context, cue: Cue, *, gain: float = 1, at: Entity | None = None) -> None:
    """Play one of the template's cues at its own level."""
    ctx.audio.play(cue.sound, volume=cue.volume * gain, at=at)


def alert(ctx: Context, text: str, seconds: float) -> None:
    """Raise the HUD's violet banner (warden entrances, the rekindle, the Vigil)."""
    run = ctx.get(Run)
    run.alert = text
    run.alert_until = ctx.time.now + seconds
