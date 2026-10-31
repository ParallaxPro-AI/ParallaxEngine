"""The field workshop's auto-pick."""

from parallax import System, system

from game.campaign import roll_on
from game.components import BattlefieldScene
from game.resources import BattleState, Phase


@system("workshop", scenes=[BattlefieldScene], runs_while_frozen=True,
        when=lambda ctx: ctx.get(BattleState).phase is Phase.WORKSHOP)
class FieldWorkshop(System):
    """The workshop panel is modal, so game time is frozen while it's open. If the
    player never picks, the first card is taken for them once the real-time timer
    runs out."""

    def update(self, ctx, dt):
        state = ctx.get(BattleState)
        if ctx.time.real_now >= state.offer_expires_at:
            roll_on(ctx, state.offer[0])
