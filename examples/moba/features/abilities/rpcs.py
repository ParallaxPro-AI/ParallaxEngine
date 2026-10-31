from parallax import Player
from parallax.net import rpc

from features.heroes.feature import RankUpRequested


@rpc("rank_up", rate_limit=10)
def rank_up(ctx, player: Player, slot: int):
    """The ability bar's + buttons (a HUD panel action)."""
    if 0 <= slot < 4:
        ctx.emit(RankUpRequested(hero=player.entity, slot=slot))
