"""The draft board's buttons, called straight from the panel."""

from parallax import ContentRef, Player
from parallax.net import rpc

from features.heroes.feature import Hero
from game.content import ChampionDef
from game.resources import Match, Phase


@rpc("pick_champion", rate_limit=5)
def pick_champion(ctx, player: Player, champion: ContentRef[ChampionDef]):
    """Hover a champion on the draft board; can change until locked in."""
    hero = player.entity.get(Hero)
    if ctx.get(Match).phase is Phase.DRAFT and not hero.locked:
        hero.champion = champion


@rpc("lock_in", rate_limit=2)
def lock_in(ctx, player: Player):
    if ctx.get(Match).phase is Phase.DRAFT:
        player.entity.get(Hero).locked = True
