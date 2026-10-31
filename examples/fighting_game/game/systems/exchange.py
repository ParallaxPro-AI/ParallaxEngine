import math

from parallax import Color, Settings, System, on, system, vec3
from parallax.characters import Character
from parallax.combat import Health
from project import Assets, Text

from game.callouts import call_out
from game.components import Challenger, Fighter, FighterState, Rival
from game.events import ExchangeResolved, StrikeLanded
from game.fighters import toward
from game.resources import Preferences
from game.rules import Rules, current_rival, frames

DAMAGE_INK = Color.hex("#fff6e4")
GUARD_INK = Color.hex("#67dce0")
ARMOUR_INK = Color.hex("#f99c80")


@system("exchange")
class Exchange(System):
    """Resolves every strike that connects: guard or clean hit, damage, stun, SPIRIT,
    knockback, hitstop and the feedback that sells it. Guarded chip is a non-lethal hit;
    difficulty scaling and "only the circuit knocks out" are damage modifiers
    (game/damage.py), so they apply to every hit."""

    @on(StrikeLanded)
    def resolve(self, ctx, event: StrikeLanded):
        rules = ctx.config(Rules)
        move = event.move.data
        attacker = event.attacker.get(Fighter)
        defender = event.defender.get(Fighter)
        blocked = defender.guarding and not (move.beats_low_guard and defender.crouching)
        armoured = not blocked and self.armoured(ctx, event, defender)
        punish = not blocked and defender.state is FighterState.RECOVERY
        damage = move.damage

        if blocked:
            damage *= rules.chip_factor
            defender.state = FighterState.BLOCKSTUN
            defender.stun_left = frames(ctx, move.blockstun)
            defender.meter = min(rules.meter_max, defender.meter + rules.meter_on_block)
        elif armoured:
            damage *= rules.armour_factor
        else:
            defender.move = None
            defender.state = FighterState.KNOCKDOWN if move.knocks_down else FighterState.HITSTUN
            defender.stun_left = frames(ctx, move.hitstun)
            defender.hits_in_combo += 1
            attacker.meter = min(rules.meter_max, attacker.meter + rules.meter_on_hit)
            defender.meter = min(rules.meter_max, defender.meter + rules.meter_on_take_hit)
        attacker.move_hit = not blocked

        dealt = event.defender.get(Health).damage(
            damage, source=event.attacker, point=event.defender.transform.position, lethal=not blocked)
        if not armoured:
            push = rules.block_knockback if blocked else move.knockback
            event.defender.get(Character).knockback(vec3(toward(event.attacker, event.defender) * push, 0, 0))
        ctx.time.hitstop(rules.block_hitstop if blocked else move.hitstop)
        self.feedback(ctx, event, blocked, armoured, punish, dealt)
        ctx.emit(ExchangeResolved(attacker=event.attacker, defender=event.defender, move=event.move,
                                  blocked=blocked, punish=punish, damage=dealt))

    def armoured(self, ctx, event, defender) -> bool:
        """The bruiser's telegraphed heavy shrugs off light hits during its startup."""
        if not event.defender.has(Rival) or defender.state is not FighterState.STARTUP:
            return False
        rival = current_rival(ctx)
        return defender.move == rival.armoured_move and event.move in rival.armour_absorbs

    def feedback(self, ctx, event, blocked, armoured, punish, dealt):
        """The original's hit pop over the defender (−damage, GUARD or ARMOUR), its sound,
        and on a clean hit the camera shake and haptic pulse the moves panel can switch off."""
        move = event.move.data
        where = event.defender
        above = where.transform.position + vec3(0, ctx.config(Rules).pop_height, 0)
        if blocked:
            ctx.audio.play(Assets.sfx.block_clank, at=where)
            ctx.ui.float_text(ctx.text(Text.pop_guard), at=above, color=GUARD_INK)
            return
        ctx.audio.play(move.hit_sound, at=where)
        if armoured:
            ctx.ui.float_text(ctx.text(Text.pop_armour), at=above, color=ARMOUR_INK)
        else:
            ctx.ui.float_text(f"\u2212{math.ceil(dealt)}", at=above, color=DAMAGE_INK)
        if not ctx.get(Settings).reduced_motion:
            ctx.camera.main.shake(move.shake, ctx.config(Rules).shake_seconds)
        if ctx.get(Preferences).haptics:
            ctx.input.rumble(1, move.rumble)
        if punish and event.attacker.has(Challenger):
            call_out(ctx, ctx.text(Text.punish))
