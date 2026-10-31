from parallax import Player
from parallax.net import rpc

from features.heroes.events import RecallRequested


@rpc("recall", rate_limit=4)
def recall(ctx, player: Player):
    """The HUD's Recall chip (the same request as the B key)."""
    ctx.emit(RecallRequested(hero=player.entity))
