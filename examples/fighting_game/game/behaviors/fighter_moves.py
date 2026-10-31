from parallax import Behavior, behavior, param, vec3
from parallax.characters import Character
from project import Prefabs, Text

from game.callouts import call_out
from game.components import Bolt, Challenger, Fighter, FighterState, Intent, Layers
from game.events import StrikeLanded, Whiffed
from game.resources import CalloutStyle
from game.rules import fighting, frames


@behavior("fighter_moves", requires=[Fighter, Intent, Character], when=fighting)
class FighterMoves(Behavior):
    """Starts buffered attacks, steps them through startup, active and recovery, and
    checks the hitbox during the active frames. Only while a round is live."""

    strike_height: float = param(1.05, unit="m", doc="Hitbox centre above the fighter's feet.")
    hitbox_margin: float = param(0.35, unit="m", doc="Added to a move's reach for the box length.")
    hitbox_depth: float = param(0.8, unit="m")
    bolt_offset: float = param(0.8, unit="m", doc="How far in front a Chi Bolt appears.")

    def update(self, ctx, dt):
        fighter = self.entity.get(Fighter)
        intent = self.entity.get(Intent)
        buffered = intent.attack is not None and ctx.time.now < intent.attack_expires_at
        if buffered and self.start_move(ctx, fighter, intent.attack):
            intent.attack = None
        if fighter.move is not None:
            self.advance(ctx, fighter, dt)

    def start_move(self, ctx, fighter, move) -> bool:
        if fighter.stun_left > 0 or fighter.guarding:
            return False
        if fighter.move is not None and not self.can_cancel(fighter, move):
            return False
        if not self.entity.get(Character).grounded:
            if move.data.in_air is None:
                return False
            move = move.data.in_air
        if fighter.meter < move.data.meter_cost:
            if self.entity.has(Challenger):
                call_out(ctx, ctx.text(Text.needs_spirit, cost=int(move.data.meter_cost)), CalloutStyle.WARN)
            return True  # consumed: the press is spent, not retried every frame

        fighter.meter -= move.data.meter_cost
        fighter.move = move
        fighter.move_time = 0.0
        fighter.move_started_at = ctx.time.now
        fighter.move_connected = False
        fighter.move_hit = False
        fighter.state = FighterState.STARTUP
        ctx.audio.play(move.data.swing_sound, at=self.entity)
        if move.data.called_out:
            call_out(ctx, ctx.text(move.data.label), CalloutStyle.CYAN)
        return True

    def can_cancel(self, fighter, move) -> bool:
        return (fighter.move_hit and fighter.state is FighterState.RECOVERY
                and move in fighter.move.data.cancels_into)

    def advance(self, ctx, fighter, dt):
        data = fighter.move.data
        fighter.move_time += dt
        active_at = frames(ctx, data.startup)
        recovery_at = frames(ctx, data.startup + data.active)
        if fighter.move_time < active_at:
            fighter.state = FighterState.STARTUP
        elif fighter.move_time < recovery_at:
            fighter.state = FighterState.ACTIVE
            if not fighter.move_connected:
                if data.throws_bolt:
                    self.throw_bolt(ctx, fighter)
                else:
                    self.check_hitbox(ctx, fighter, data)
        else:
            fighter.state = FighterState.RECOVERY

        if fighter.move_time >= recovery_at + frames(ctx, data.recovery):
            if not fighter.move_connected:
                ctx.emit(Whiffed(entity=self.entity, move=fighter.move))
            fighter.move = None
            fighter.state = FighterState.NEUTRAL

    def check_hitbox(self, ctx, fighter, data):
        reach = data.reach + self.hitbox_margin
        center = self.entity.transform.position + vec3(fighter.facing * reach / 2, self.strike_height, 0)
        size = vec3(reach, data.box_height, self.hitbox_depth)
        for other in ctx.physics.overlap_box(center, size, layers=[Layers.fighter], ignore=[self.entity]):
            fighter.move_connected = True
            ctx.emit(StrikeLanded(attacker=self.entity, defender=other, move=fighter.move))
            return

    def throw_bolt(self, ctx, fighter):
        """One live bolt per fighter keeps zoning deliberate."""
        fighter.move_connected = True
        if ctx.world.query(Bolt).where(lambda _, bolt: bolt.owner == self.entity).count():
            return
        at = self.entity.transform.position + vec3(fighter.facing * self.bolt_offset, self.strike_height, 0)
        ctx.world.spawn(Prefabs.chi_bolt, at=at, components=[Bolt(owner=self.entity, heading=fighter.facing)])
