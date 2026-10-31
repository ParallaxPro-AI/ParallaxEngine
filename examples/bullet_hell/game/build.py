"""Read-only helpers: the current wave, the Wisp, the run's end, and folding an
attunement into the Wisp's build."""

from parallax import Context, ContentRef, Entity
from parallax.combat import Health

from game.components import Wisp
from game.config import Arena
from game.content import GuardianDef, Stat, UpgradeDef, WaveDef
from game.resources import Run, Shrine


def current_wave(ctx: Context) -> ContentRef[WaveDef]:
    return ctx.content(WaveDef)[ctx.get(Run).wave_index]


def is_final_wave(ctx: Context) -> bool:
    return ctx.get(Run).wave_index == len(ctx.content(WaveDef)) - 1


def stacks(ctx: Context, upgrade: ContentRef[UpgradeDef]) -> int:
    return ctx.get(Shrine).taken.count(upgrade)


def find_wisp(ctx: Context) -> Entity:
    wisp, _ = ctx.world.query(Wisp).single()
    return wisp


def run_over(ctx: Context) -> bool:
    """The Thornmother's wave is cleared, or the Wisp's last petal has fallen."""
    return ctx.get(Run).won or find_wisp(ctx).get(Health).dead


def attune(wisp: Entity, upgrade: ContentRef[UpgradeDef], taken: int) -> None:
    """Fold an attunement taken `taken` times into the Wisp's build as one modifier
    keyed by the attunement, so the stat reads (stock + every add) x every mul."""
    data = upgrade.data
    kind, name = (Health, "max") if data.stat is Stat.MAX_LIVES else (Wisp, data.stat.value)
    wisp.modify(kind, name, add=data.add * taken, multiply=data.mul ** taken, key=upgrade.id)


def body_reach(ctx: Context, radius: float, kind: GuardianDef) -> float:
    """Contact distance with a guardian: bigger guardians reach further."""
    return radius + (kind.scale - ctx.config(Arena).standard_scale) / 2
