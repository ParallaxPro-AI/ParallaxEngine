from parallax import Behavior, behavior
from parallax.combat import Health

from features.fighting.feature import Attacker
from features.heroes.components import Orders
from game.actions import Controls


@behavior("player_orders", requires=[Orders, Attacker, Health])
class PlayerOrders(Behavior):
    """Right-click walks to the pointer or attacks the enemy under it; S stops.
    Predicted (`net(predict=[PlayerOrders, HeroMotor])`): it also runs on the owner's
    client, so the champion turns and walks the moment you click; the server, running
    the same code on the same input, stays the authority."""

    def update(self, ctx, dt):
        if self.entity.get(Health).dead:
            return
        pointer = ctx.input.pointer
        orders = self.entity.get(Orders)
        attacker = self.entity.get(Attacker)
        if ctx.input.pressed(Controls.order):
            clicked = pointer.over
            if clicked and clicked.has(Health) and ctx.combat.are_enemies(self.entity, clicked):
                attacker.target, orders.destination = clicked, None
            else:
                attacker.target, orders.destination = None, pointer.world
        if ctx.input.pressed(Controls.stop):
            attacker.target, orders.destination = None, None
