from parallax import Behavior, Color, Model, Vec3, behavior, heading_to, on, param, state, vec3
from parallax.characters import Character
from parallax.combat import Damaged, Died, Health
from project import Assets

from game.audio import Sounds
from features.creatures.components import Mob
from game.world import the_player


@behavior("hostile_mob", requires=[Mob, Character, Health, Model])
class HostileMob(Behavior):
    """Hunts the player across the blocks, hopping up ledges. Before each blow it
    winds up visibly, and the blow only lands if the player is still in reach
    with nothing solid in between, so walls and a closed door really protect."""

    detect_range: float = param(30, unit="m")
    reach_height: float = param(1.5, unit="m", doc="Largest height difference a blow can cross.")
    eye_height: float = param(1.0, unit="m")
    windup_left: float = state(0.0)
    cooldown_left: float = state(0.0)

    def start(self, ctx):
        kind = self.entity.get(Mob).kind.data
        health = self.entity.get(Health)
        health.max = health.current = kind.health
        self.entity.get(Character).walk_speed = kind.move_speed
        self.entity.get(Model).tint = kind.color
        self.entity.transform.scale = kind.scale

    def update(self, ctx, dt):
        kind = self.entity.get(Mob).kind.data
        body = self.entity.get(Character)
        player = the_player(ctx)
        gap = player.transform.position - self.entity.transform.position
        self.cooldown_left = max(0.0, self.cooldown_left - dt)
        if player.get(Health).dead or gap.length() > self.detect_range:
            body.stop()
            return
        body.face(heading_to(self.entity.transform.position, player.transform.position))

        if self.windup_left > 0:
            body.stop()
            self.windup_left -= dt
            if self.windup_left <= 0:
                if self._can_hit(ctx, gap, kind.attack_range):
                    player.get(Health).damage(kind.damage, source=self.entity)
                self.cooldown_left = kind.attack_interval
            return

        if gap.flat().length() > kind.attack_range * 0.9:
            body.move(gap.flat().normalized())
            if body.grounded and body.velocity.flat().length() < 0.2:
                body.jump()
        else:
            body.stop()
        if self.cooldown_left == 0 and self._can_hit(ctx, gap, kind.attack_range):
            self.windup_left = kind.windup
            ctx.vfx.play(Assets.vfx.windup_sparks, at=self.entity.transform.position + vec3(0, 1.2, 0))

    def _can_hit(self, ctx, gap: Vec3, reach: float) -> bool:
        eye = self.entity.transform.position + vec3(0, self.eye_height, 0)
        return (gap.length() <= reach and abs(gap.y) < self.reach_height
                and ctx.voxels.raycast(eye, gap.normalized(), gap.length()) is None)

    @on(Damaged)
    def hit(self, ctx, event: Damaged):
        """Each blow you land floats its damage over the creature."""
        ctx.ui.float_text(str(round(event.amount)), self.entity.transform.position + vec3(0, 1.6, 0),
                          color=Color.hex("#ffe08a"))

    @on(Died)
    def died(self, ctx, event: Died):
        ctx.vfx.play(Assets.vfx.smoke_puff, at=self.entity.transform.position + vec3(0, 0.9, 0))
        ctx.audio.play(ctx.config(Sounds).mob_death, at=self.entity, volume=0.3)
