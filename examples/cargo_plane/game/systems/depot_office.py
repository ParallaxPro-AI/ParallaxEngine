from parallax import SceneLoaded, System, on, system
from parallax.vehicles import Vehicle
from project import Scenes

from game.actions import Controls
from game.board import roll_offers
from game.config import FreightRules
from game.cues import Cues, play
from game.resources import Board
from game.rules import depot_near, flown, interactor
from game.ui import OfficePanel


@system("depot_office", scenes=[Scenes.archipelago])
class DepotOffice(System):
    """Opens the depot office — the contract board and the hangar shop — beside any
    island's pad, on foot or parked. The board belongs to the island you're at:
    arriving somewhere new with an empty hold deals a fresh one there, but reopening
    never re-deals, so there is no fishing for a jackpot contract. Its buttons are
    the functions in game/office.py. A new career starts with the board at home dealt
    (and its first job on the manifest)."""

    @on(SceneLoaded)
    def open_the_first_board(self, ctx, event):
        if ctx.get(Board).island is None:
            roll_offers(ctx, ctx.config(FreightRules).home)

    def update(self, ctx, dt):
        if not ctx.input.pressed(Controls.office):
            return
        island = depot_near(ctx, interactor(ctx).transform.position, ctx.config(FreightRules).office_radius)
        seat = flown(ctx)
        if island is None or (seat is not None and not seat.get(Vehicle).grounded):
            return
        board = ctx.get(Board)
        if island != board.island and not board.loaded:
            roll_offers(ctx, island)
        play(ctx, ctx.config(Cues).office)
        ctx.ui.open(OfficePanel)
