import random

from parallax import Behavior, behavior, param, state
from parallax.characters import Character
from project import Content

from game.components import Bolt, Fighter, FighterState, Intent
from game.content import Style
from game.fighters import buffer_attack, opponent_of, toward
from game.resources import Dummy, Match, Mode
from game.rules import current_lesson, current_rival, difficulty, fighting


@behavior("rival_brain", requires=[Fighter, Intent, Character], when=fighting)
class RivalBrain(Behavior):
    """Plays the current rival while a round is live. It makes ONE delayed guard
    decision per attack it sees (never per-frame rerolls), dodges bolts, and picks
    attacks by the rival's style. In training it runs the lesson's drill; in practice it
    is the dummy. Its waits are deadlines, so they keep running between rounds."""

    guard_range: float = param(2.6, unit="m")
    bolt_alert_range: float = param(3.3, unit="m")
    strike_range: float = param(1.75, unit="m")
    punish_range: float = param(1.9, unit="m")
    anti_air_range: float = param(2.0, unit="m")
    zoning_range: float = param(2.6, unit="m", doc="Zoners throw bolts from beyond this gap.")
    spacing_slack: float = param(0.3, unit="m")
    approach_pace: float = param(0.8, min=0, max=1, doc="Stick amount when closing in.")
    retreat_pace: float = param(0.6, min=0, max=1, doc="Stick amount when backing off.")
    jab_chance: float = param(0.65, min=0, max=1)
    dodge_cooldown: float = param(0.8, unit="s")
    drill_range: float = param(1.45, unit="m", doc="Training: how close the dummy walks before attacking.")
    drill_cooldown: float = param(1.8, unit="s")
    drill_pace: float = param(0.6, min=0, max=1)

    next_move_at: float = state(0.0, doc="Game time the rival may attack or dodge again.")
    react_at: float = state(0.0, doc="Game time the rival may act on the attack it last saw.")
    seen_attack_at: float = state(-1.0)
    will_guard: bool = state(False)

    def update(self, ctx, dt):
        me = self.entity.get(Fighter)
        intent = self.entity.get(Intent)
        intent.walk = 0.0
        intent.crouch = False
        if me.stun_left > 0 or me.move is not None:
            intent.guard = intent.guard and me.state is FighterState.BLOCKSTUN
            return

        foe_entity = opponent_of(ctx, self.entity)
        foe = foe_entity.get(Fighter)
        gap = abs(foe_entity.transform.position.x - self.entity.transform.position.x)
        facing = toward(self.entity, foe_entity)

        match = ctx.get(Match)
        if match.mode is Mode.PRACTICE and match.dummy is not Dummy.SPAR:
            intent.guard = match.dummy is Dummy.GUARD
        elif match.mode is Mode.TRAINING:
            self.drill(ctx, intent, gap, facing, current_lesson(ctx).rival_attack)
        else:
            self.fight(ctx, intent, me, foe_entity, foe, gap, facing)

    def fight(self, ctx, intent, me, foe_entity, foe, gap, facing):
        rival = current_rival(ctx)
        level = difficulty(ctx)
        now = ctx.time.now
        self.watch(now, foe, rival, level)
        reacted = now >= self.react_at
        intent.guard = self.will_guard and reacted and foe.move is not None and gap < self.guard_range

        if self.bolt_incoming(ctx, foe_entity):
            if rival.style in (Style.ZONING, Style.BOSS):
                intent.crouch = True
            elif now >= self.next_move_at:
                intent.jump = True
                self.next_move_at = now + self.dodge_cooldown
        if intent.guard or intent.crouch:
            return

        if now >= self.next_move_at:
            move = self.choose_attack(rival, me, foe, not foe_entity.get(Character).grounded, gap, reacted)
            if move is not None:
                buffer_attack(ctx, intent, move)
                self.next_move_at = now + rival.cadence * level.cadence_scale
                return
        self.keep_spacing(intent, rival.spacing, gap, facing)

    def watch(self, now, foe, rival, level):
        """A new attack from the opponent sets the reaction deadline and rolls the guard once."""
        if foe.move is not None and foe.move_started_at != self.seen_attack_at:
            self.seen_attack_at = foe.move_started_at
            self.react_at = now + rival.reaction * level.reaction_scale
            self.will_guard = random.random() < rival.block_chance

    def bolt_incoming(self, ctx, foe_entity) -> bool:
        x = self.entity.transform.position.x
        return ctx.world.query(Bolt).where(
            lambda entity, bolt: bolt.owner == foe_entity and abs(entity.transform.position.x - x) < self.bolt_alert_range
        ).count() > 0

    def choose_attack(self, rival, me, foe, foe_airborne, gap, reacted):
        if rival.style is Style.ANTIAIR and foe_airborne and gap < self.anti_air_range:
            return Content.move.heavy
        if foe.state is FighterState.RECOVERY and gap < self.punish_range and reacted:
            return Content.move.heavy
        if rival.style is Style.ZONING and gap > self.zoning_range:
            return Content.move.chi_bolt
        if gap >= self.strike_range:
            return None
        if rival.style is Style.BOSS and me.meter >= Content.move.circuit_breaker.data.meter_cost:
            return Content.move.circuit_breaker
        if rival.style is Style.ARMOUR:
            return Content.move.heavy
        return Content.move.jab if random.random() < self.jab_chance else Content.move.heavy

    def keep_spacing(self, intent, spacing, gap, facing):
        if gap > spacing + self.spacing_slack:
            intent.walk = facing * self.approach_pace
        elif gap < spacing - self.spacing_slack:
            intent.walk = -facing * self.retreat_pace

    def drill(self, ctx, intent, gap, facing, attack):
        """Training: walk in and throw the lesson's attack on a slow, readable rhythm."""
        intent.guard = False
        if attack is None or ctx.time.now < self.next_move_at:
            return
        if gap > self.drill_range:
            intent.walk = facing * self.drill_pace
        else:
            buffer_attack(ctx, intent, attack)
            self.next_move_at = ctx.time.now + self.drill_cooldown
