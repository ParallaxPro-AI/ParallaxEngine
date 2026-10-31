"""Owning and wearing gear."""

from parallax import Context, ContentRef

from features.inventory.content import GearDef
from features.inventory.resources import Gear


def worn_pieces(ctx: Context) -> list[GearDef]:
    return [piece.data for piece in ctx.get(Gear).worn.values()]


def grant_gear(ctx: Context, piece: ContentRef[GearDef]) -> bool:
    """Adds a found piece. A plain upgrade over the worn piece is worn at once; returns whether it was."""
    gear = ctx.get(Gear)
    gear.owned.append(piece)
    worn = gear.worn.get(piece.data.slot)
    if piece.data.element is not None or (worn is not None and worn.data.tier >= piece.data.tier):
        return False
    gear.worn[piece.data.slot] = piece
    return True


def equip(ctx: Context, piece: ContentRef[GearDef]) -> None:
    """The gear screen's buttons: wear an owned piece in its slot."""
    gear = ctx.get(Gear)
    if piece in gear.owned:
        gear.worn[piece.data.slot] = piece
