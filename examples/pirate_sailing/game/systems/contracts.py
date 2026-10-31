import math

from parallax import System, Vec3, on, system
from parallax.combat import Died
from project import Assets, Prefabs, Text

from game.components import CrewShip, CursedHoard, Ghost, Kraken, Shark
from game.config import Deed, Sounds
from game.content import ContractDef, ContractKind, Stat
from game.events import LegStarted
from game.resources import Voyage
from game.rules import refit, sailing
from game.standing import bounty_scale, record_deed

HOARD_REACH = 6.0
"""Sail within this many meters of a cursed hoard to raise it."""
DEEDS = {
    ContractKind.GHOST: Deed.CONTRACT_GHOST,
    ContractKind.MONSTER: Deed.CONTRACT_MONSTER,
    ContractKind.TREASURE: Deed.CONTRACT_TREASURE,
}


def take_next_contract(ctx, ship) -> bool:
    """The contract board: open the next contract in order (they repeat) unless one is
    already open. A treasure contract scatters its hoards in a ring around `ship`."""
    voyage = ctx.get(Voyage)
    board = ctx.content(ContractDef)
    if voyage.contract is not None or not sailing(ctx) or len(board) == 0:
        return False
    contract = board[voyage.contracts_taken % len(board)]
    voyage.contracts_taken += 1
    voyage.contract, voyage.contract_progress = contract, 0
    terms = contract.data
    if terms.kind is ContractKind.TREASURE:
        at = ship.transform.position
        for index in range(terms.hoards):
            angle = index / terms.hoards * math.tau + 0.6
            reach = terms.radius + index * 18
            ctx.world.spawn(Prefabs.cursed_hoard, at=Vec3(at.x + math.cos(angle) * reach, 0.45, at.z + math.sin(angle) * reach))
    ctx.audio.play(ctx.config(Sounds).refit_open, volume=0.35)
    ctx.ui.toast(ctx.text(Text.contract_taken, label=ctx.text(terms.label)))
    return True


@system("contracts")
class Contracts(System):
    """Tracks the open contract: hulls of its kind going down, or its hoards raised. A
    finished contract pays its gold (scaled like a bounty) into the purse and the leg's
    hold, and earns standing with the power that posted it. A new leg clears the board."""

    @on(LegStarted)
    def fresh_board(self, ctx, event):
        voyage = ctx.get(Voyage)
        voyage.contract, voyage.contract_progress = None, 0
        for hoard in ctx.world.query(tagged=CursedHoard):
            hoard.destroy()

    @on(Died, where=lambda event: event.entity.has(Ghost) or event.entity.has(Kraken) or event.entity.has(Shark))
    def hull_down(self, ctx, event):
        voyage = ctx.get(Voyage)
        if voyage.contract is None:
            return
        kind = voyage.contract.data.kind
        if (kind is ContractKind.GHOST and event.entity.has(Ghost)) or (
                kind is ContractKind.MONSTER and not event.entity.has(Ghost)):
            voyage.contract_progress += 1
            self.check_done(ctx)

    def update(self, ctx, dt):
        voyage = ctx.get(Voyage)
        if voyage.contract is None or voyage.contract.data.kind is not ContractKind.TREASURE:
            return
        for ship in ctx.world.query(tagged=CrewShip):
            for hoard in ctx.world.query(tagged=CursedHoard).near(ship.transform.position, HOARD_REACH):
                ctx.vfx.play(Assets.vfx.hoard_sparkle, at=hoard.transform.position + Vec3(0, 0.6, 0))
                hoard.destroy()
                voyage.contract_progress += 1
        self.check_done(ctx)

    def check_done(self, ctx):
        voyage = ctx.get(Voyage)
        terms = voyage.contract.data
        if voyage.contract_progress < terms.goal:
            return
        gold = round(terms.gold * bounty_scale(ctx, refit(ctx, Stat.BOUNTY_BONUS)))
        voyage.purse += gold
        voyage.leg_gold += gold
        voyage.contract, voyage.contract_progress = None, 0
        voyage.contracts_paid += 1
        for hoard in ctx.world.query(tagged=CursedHoard):
            hoard.destroy()
        record_deed(ctx, DEEDS[terms.kind])
        ctx.audio.play(ctx.config(Sounds).bounty, volume=0.45)
        ctx.ui.toast(ctx.text(Text.contract_paid, gold=gold))
