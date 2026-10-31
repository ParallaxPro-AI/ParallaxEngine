from parallax import Behavior, behavior, param, vec3
from parallax.characters import Character

from game.components import Fighter, FighterState, Intent
from game.fighters import opponent_of, toward
from game.rules import fighting


@behavior("fighter_motion", requires=[Fighter, Intent, Character])
class FighterMotion(Behavior):
    """Walks, jumps, guards and crouches on the fight line, always facing the opponent.
    It runs in every phase: outside a live round it keeps the fighter facing their
    opponent, standing still and out of guard."""

    back_walk_factor: float = param(0.72, min=0, max=1)
    guard_walk_factor: float = param(0.38, min=0, max=1)

    def update(self, ctx, dt):
        fighter = self.entity.get(Fighter)
        intent = self.entity.get(Intent)
        body = self.entity.get(Character)
        live = fighting(ctx)
        recovered = fighter.stun_left == 0 and fighter.move is None

        can_guard = live and body.grounded and fighter.move is None and (
            fighter.stun_left == 0 or fighter.state is FighterState.BLOCKSTUN)
        fighter.guarding = intent.guard and can_guard
        fighter.crouching = intent.crouch and can_guard

        if fighter.move is None:
            fighter.facing = toward(self.entity, opponent_of(ctx, self.entity))
            body.face(90 * fighter.facing)

        if intent.jump and live and recovered and not (fighter.guarding or fighter.crouching):
            body.jump()
        intent.jump = False

        can_walk = live and fighter.stun_left == 0 and not fighter.crouching and (
            fighter.move is None or not body.grounded)
        body.move(vec3(intent.walk * self.walk_factor(fighter, intent), 0, 0) if can_walk else vec3())

    def walk_factor(self, fighter, intent):
        factor = self.back_walk_factor if intent.walk * fighter.facing < 0 else 1.0
        return factor * (self.guard_walk_factor if fighter.guarding else 1.0)
