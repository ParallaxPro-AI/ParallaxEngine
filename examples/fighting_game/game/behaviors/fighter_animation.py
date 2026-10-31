from parallax import Animator, Behavior, behavior, param
from parallax.characters import Character
from project import Assets

from game.components import Fighter, FighterState
from game.rules import fighting

CLIPS = Assets.clips
ONE_SHOT_STATES = {
    FighterState.HITSTUN: CLIPS.hitstun,
    FighterState.BLOCKSTUN: CLIPS.blockstun,
    FighterState.KNOCKDOWN: CLIPS.knockdown,
    FighterState.LANDING: CLIPS.landing,
    FighterState.VICTORY: CLIPS.victory,
    FighterState.KO: CLIPS.ko,
}


@behavior("fighter_animation", requires=[Fighter, Character, Animator])
class FighterAnimation(Behavior):
    """Plays the clip that matches the fighter's state (the Animator ignores repeats)."""

    blend: float = param(0.035, unit="s")
    walk_threshold: float = param(0.1, unit="m/s")

    def update(self, ctx, dt):
        clip, loop = self.pick_clip(ctx, self.entity.get(Fighter), self.entity.get(Character))
        self.entity.get(Animator).play(clip, loop=loop, fade=self.blend)

    def pick_clip(self, ctx, fighter, body):
        if fighter.move is not None:
            return fighter.move.data.clip, False
        if fighter.state in ONE_SHOT_STATES:
            return ONE_SHOT_STATES[fighter.state], False
        if not body.grounded:
            return CLIPS.jump, True
        if fighter.crouching:
            return CLIPS.crouch, True
        if fighter.guarding:
            return CLIPS.block, True
        speed = body.velocity.x * fighter.facing
        if fighting(ctx) and abs(speed) > self.walk_threshold:
            return (CLIPS.walk if speed > 0 else CLIPS.backstep), True
        return CLIPS.guard, True
