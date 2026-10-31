"""What makes a unit a champion. Each field replicates only as far as someone
needs it: the draft board shows every pick, your HUD shows your own numbers."""

from parallax import ContentRef, Vec3, component, field
from project import Content

from game.content import AbilityDef, ChampionDef, StatBlock


@component("hero")
class Hero:
    champion: ContentRef[ChampionDef] = field(Content.champion.warrior, replicate=True)
    locked: bool = field(False, replicate=True, doc="The draft pick is final.")
    respawn_at: float = field(0, unit="s", replicate="owner")
    recall_at: float = field(0, unit="s", replicate="owner", doc="When a recall in progress completes; 0 = none.")
    kills: int = field(0, replicate=True)
    deaths: int = field(0, replicate=True)
    streak: int = field(0, doc="Kills since this champion last died.")
    earned: StatBlock = field(StatBlock(), doc="Permanent rewards from jungle camps, summed.")


@component("orders")
class Orders:
    """Where the hero was told to walk. Attack orders live in Attacker.target."""
    destination: Vec3 | None = field(None, replicate="owner")


@component("mana")
class Mana:
    current: float = field(0, min=0, replicate="team")


@component("progression")
class Progression:
    level: int = field(1, min=1, replicate=True)
    xp: float = field(0, min=0, replicate="owner")
    skill_points: int = field(1, min=0, replicate="owner")


@component("ability_book")
class AbilityBook:
    """The four abilities (Q, W, E, R), their ranks and when each is ready again."""
    abilities: list[ContentRef[AbilityDef]] = field([], replicate=True)
    ranks: list[int] = field([0, 0, 0, 0], replicate="owner")
    ready_at: list[float] = field([0, 0, 0, 0], replicate="owner")


@component("fountain")
class Fountain:
    """A team's spawn, recall point and healing pool."""
    radius: float = field(8, unit="m")
    health_per_second: float = field(0.15, doc="Fraction of max health.")
    mana_per_second: float = field(0.20, doc="Fraction of max mana.")
