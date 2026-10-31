"""The one vocabulary items and vault boons both speak: an effect and an amount."""

from parallax import Context
from parallax.combat import Health
from project import Placed

from game.content import Effect
from game.resources import Run
from game.rules import Rules


def apply_effect(ctx: Context, effect: Effect, amount: float) -> None:
    """Health effects act on the keeper's `Health`; the rest change the run's numbers."""
    rules = ctx.config(Rules)
    run = ctx.get(Run)
    health = ctx.world.placed(Placed.keeper).get(Health)
    if effect is Effect.COINS:
        run.coins += int(amount)
    elif effect is Effect.HEALTH:
        health.heal(amount)
    elif effect is Effect.KEYS:
        run.keys += int(amount)
    elif effect is Effect.BOMBS:
        run.bombs += int(amount)
    elif effect is Effect.MAX_HEALTH:
        health.max += amount
        health.heal(amount)
    elif effect is Effect.FIRE_INTERVAL:
        run.fire_interval = max(rules.min_fire_interval, run.fire_interval + amount)
    elif effect is Effect.SHARD_DAMAGE:
        run.shard_damage += amount
    elif effect is Effect.SHARD_SPEED:
        run.shard_speed += amount
    elif effect is Effect.MOVE_SPEED:
        run.move_speed = min(rules.max_move_speed, run.move_speed + amount)
