from parallax import System, on, system, vec3
from project import Assets

from game.components import Pot, PotState
from game.content import KitchenSounds, ServiceRules
from game.events import PotBurnt
from game.resources import Service
from game.rules import penalize, play


@system("stoves")
class Stoves(System):
    """Soup cooks, then holds, then BURNS. The pots are why a second pair of hands
    is worth having: somebody has to watch them. A burnt pot costs the leading chef
    points, shakes both halves of the screen and leaves burnt food for the bin."""

    def update(self, ctx, dt):
        for stove, pot in ctx.world.query(Pot).where(
                lambda stove, pot: pot.state in (PotState.COOKING, PotState.READY)):
            pot.time_left -= dt
            if pot.time_left > 0:
                continue
            if pot.state is PotState.COOKING:
                pot.state = PotState.READY
                pot.time_left = pot.burn_seconds
                play(ctx, ctx.config(KitchenSounds).cook_ready)
                ctx.vfx.play(Assets.vfx.soup_ready, at=stove.transform.position + vec3(0, 1.6, 0))
            else:
                pot.state = PotState.BURNT
                pot.contents = ctx.config(ServiceRules).burnt
                ctx.emit(PotBurnt(stove=stove))

    @on(PotBurnt)
    def burnt(self, ctx, event):
        service = ctx.get(Service)
        service.burnt += 1
        service.streak = 0
        leader = max(ctx.players, key=lambda player: service.scores[player.index])
        penalize(ctx, leader, ctx.config(ServiceRules).burn_penalty)
        play(ctx, ctx.config(KitchenSounds).burn)
        ctx.vfx.play(Assets.vfx.burnt_smoke, at=event.stove.transform.position + vec3(0, 1.6, 0))
        for player in ctx.players:
            ctx.camera.for_player(player).shake(0.25, 0.24)
