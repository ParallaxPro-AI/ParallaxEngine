from parallax import Behavior, behavior

from game.actions import Helm
from game.components import Broadsides
from game.rules import sailing
from game.systems.contracts import take_next_contract


@behavior("contract_board", requires=[Broadsides], when=sailing)
class ContractBoard(Behavior):
    """Q at sea takes the next contract off the board for the whole fleet (the HUD's
    Contract button does the same through the `take_contract` RPC)."""

    def update(self, ctx, dt):
        if ctx.input.pressed(Helm.contract):
            take_next_contract(ctx, self.entity)
