"""Content registries: levels, collectibles and enemies."""

from enum import Enum

from parallax import Localized, SceneRef, SoundRef, content, field


class CollectibleKind(Enum):
    COIN = "coin"
    GEM = "gem"
    HEART = "heart"
    KEEPSAKE = "keepsake"


@content("level", order="order")
class LevelDef:
    """One world, played in `order`; all are open from the start. Its geometry
    and music are in its scene, which carries the `level` scene tag."""

    name: Localized
    subtitle: Localized
    world: Localized = field(doc="The land it is in, on its atlas card (Meadow, Frost).")
    theme: str = field("meadow", choices=["meadow", "crystal", "frost", "ember"], doc="Its atlas tint.")
    scene: SceneRef
    order: int
    length: float = field(unit="m", doc="Distance from the start to the sky gate, for the progress bar.")
    par_time: float = field(unit="s", doc="Beat it without dying for the third star.")
    sections: list[Localized] = field(doc="Named stretches of the level, in order.")


@content("collectible")
class CollectibleDef:
    """Something to pick up. Coins and gems score (times the chain); a heart
    restores a life; a keepsake is one of the level's three hidden finds."""

    kind: CollectibleKind
    points: int = field(0)
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@content("enemy")
class EnemyDef:
    """Something that walks into you. Stompable ones can be flattened from above."""

    stompable: bool = field(True)
    points: int = field(25)
