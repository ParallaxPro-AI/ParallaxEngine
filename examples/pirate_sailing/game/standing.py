"""Standing with the three powers of the sea (content/faction, config/standing.json).
Only the server moves it; every client reads the replicated `Voyage.standing`."""

from parallax import Context, ContentRef

from game.config import Deed, StandingRules, VoyageRules
from game.content import FactionDef, PerkKind, Rank
from game.resources import Voyage


def standing(ctx: Context, faction: ContentRef[FactionDef]) -> float:
    return ctx.get(Voyage).standing.get(faction.id, faction.data.start)


def rank(ctx: Context, faction: ContentRef[FactionDef]) -> Rank:
    """The highest rung at or below the faction's standing."""
    value = standing(ctx, faction)
    rungs = sorted(faction.data.ranks, key=lambda rung: rung.at)
    best = rungs[0]
    for rung in rungs:
        if value >= rung.at:
            best = rung
    return best


def perk(ctx: Context, faction_id: str) -> float:
    for faction in ctx.content(FactionDef):
        if faction.id == faction_id:
            return rank(ctx, faction).perk
    return 0.0


def bounty_scale(ctx: Context, refit_bonus: float) -> float:
    """Bounties and contract purses: Letter of Marque plus the Crown's regard."""
    return max(0.1, 1 + refit_bonus + perk(ctx, "crown"))


def hoard_scale(ctx: Context, refit_bonus: float) -> float:
    """Chests: Lucky Charts plus what the Brethren's fences add."""
    return max(0.1, 1 + refit_bonus + perk(ctx, "brethren"))


def shelf_bonus(ctx: Context) -> int:
    """Refit cards the Merchant Guild adds to (or takes off) the shelf."""
    return int(perk(ctx, "merchants"))


def perk_text(ctx: Context, faction: ContentRef[FactionDef]) -> str:
    value = rank(ctx, faction).perk
    label = ctx.text(faction.data.perk_label)
    if faction.data.perk_kind is PerkKind.CARDS:
        return f"{label}: {ctx.config(VoyageRules).refit_offers + int(value)} offers"
    return f"{label}: {'+' if value >= 0 else ''}{round(value * 100)}%"


def record_deed(ctx: Context, deed: Deed) -> None:
    """Move every faction the deed touches (allies and rivals one hop), and announce a
    faction whose rank changed."""
    for row in ctx.config(StandingRules).deeds:
        if row.deed is deed:
            _change(ctx, row.faction, row.amount)


def _change(ctx: Context, faction: ContentRef[FactionDef], amount: float) -> None:
    _apply(ctx, faction, amount)
    for ally in faction.data.allies:
        _apply(ctx, ally.faction, amount * ally.share)
    for rival in faction.data.rivals:
        _apply(ctx, rival.faction, -amount * rival.share)


def _apply(ctx: Context, faction: ContentRef[FactionDef], amount: float) -> None:
    before = rank(ctx, faction)
    data = faction.data
    value = min(data.max, max(data.min, standing(ctx, faction) + amount))
    ctx.get(Voyage).standing[faction.id] = round(value, 2)
    after = rank(ctx, faction)
    if after.at != before.at:
        ctx.ui.toast(f"{ctx.text(data.name)}: {ctx.text(after.name)} - {perk_text(ctx, faction)}", seconds=3)
