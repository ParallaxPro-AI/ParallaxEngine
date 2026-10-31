"""Client → server calls. The refit cards and the game-over button bind to these
directly; everything else syncs itself (replicated fields, owned-ship input, and
feedback called on the server)."""

from parallax import ContentRef, Player
from parallax.net import rpc

from game.config import Sounds, VoyageRules
from game.content import UpgradeDef
from game.events import LegStarted
from game.resources import Phase, Voyage
from game.rules import current_leg
from game.systems.contracts import take_next_contract


@rpc("pick_refit", rate_limit=2)
def pick_refit(ctx, player: Player, upgrade: ContentRef[UpgradeDef]):
    """The first captain to choose fits the card to every ship and starts the clock."""
    voyage = ctx.get(Voyage)
    if voyage.phase is not Phase.REFIT or upgrade not in voyage.offers:
        return
    voyage.levels[upgrade.id] = voyage.levels.get(upgrade.id, 0) + 1
    voyage.offers = []
    voyage.phase = Phase.SAILING
    voyage.time_left = current_leg(ctx).duration
    voyage.leg_gold = voyage.bounty = 0
    ctx.emit(LegStarted(leg=voyage.leg))
    ctx.audio.play(ctx.config(Sounds).refit_pick)
    ctx.audio.play(ctx.config(Sounds).leg_start, volume=0.5)


@rpc("take_contract", rate_limit=2)
def take_contract(ctx, player: Player):
    """The contract board (Q at sea): any captain opens the next contract for the fleet."""
    if player.entity is not None:
        take_next_contract(ctx, player.entity)


@rpc("sail_again", rate_limit=1)
def sail_again(ctx, player: Player):
    """Any captain can start a fresh voyage once this one is over."""
    if ctx.get(Voyage).phase is Phase.ENDED:
        ctx.scenes.load(ctx.config(VoyageRules).legs[0].data.scene, new_run=True)
