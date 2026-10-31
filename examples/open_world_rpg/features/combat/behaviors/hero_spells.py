"""The hero's two ability slots."""

from parallax import Behavior, behavior, heading_to, vec2, vec3
from parallax.characters import Character
from parallax.combat import Health
from project import Text

from features.combat.actions import CombatControls
from features.combat.components import Spellbook
from features.combat.content import AbilityDef
from features.combat.events import Staggered
from features.combat.tags import Hostile
from features.hero.feature import Mana, Progression
from game.feed import hint


@behavior("hero_spells", requires=[Spellbook, Mana, Health, Character])
class HeroSpells(Behavior):
    """Slot 1 and slot 2 cast whatever the spellbook holds there: Runebreak's interrupting wave, and Mend.
    Numbers come from content/ability; cooldowns live on the Spellbook so the HUD can show them."""

    def update(self, ctx, dt):
        book = self.entity.get(Spellbook)
        for ability in book.cooldowns:
            book.cooldowns[ability] = max(0.0, book.cooldowns[ability] - dt)
        if self.entity.get(Health).dead:
            return
        if ctx.input.pressed(CombatControls.ability_1):
            self.cast(ctx, book, slot=1)
        if ctx.input.pressed(CombatControls.ability_2):
            self.cast(ctx, book, slot=2)

    def cast(self, ctx, book: Spellbook, slot: int):
        ability = next((a for a in book.known if a.data.slot == slot), None)
        if ability is None:
            hint(ctx, ctx.text(ctx.content(AbilityDef).first(lambda a: a.slot == slot).data.locked_hint))
            return
        spec = ability.data
        mana = self.entity.get(Mana)
        if book.cooldowns.get(ability, 0) > 0:
            hint(ctx, ctx.text(Text.ability_recharging, ability=ctx.text(spec.name)))
        elif mana.current < spec.mana_cost:
            hint(ctx, ctx.text(Text.ability_needs_mana, ability=ctx.text(spec.name), mana=round(spec.mana_cost)))
        else:
            mana.current -= spec.mana_cost
            book.cooldowns[ability] = spec.cooldown
            if spec.form == "wave":
                self.wave(ctx, spec)
            else:
                self.mend(ctx, spec)
            ctx.audio.play(spec.sound, volume=spec.volume)

    def wave(self, ctx, spec: AbilityDef):
        origin = self.entity.transform.position
        facing = ctx.camera.main.relative(vec2(0, 1)).normalized()
        self.entity.get(Character).face(heading_to(origin, origin + facing))
        power = spec.damage * (1 + (ctx.get(Progression).level - 1) * spec.scaling_per_level)
        hits = 0
        for foe, health in ctx.world.query(Health, tagged=Hostile).near(origin, spec.reach):
            offset = (foe.transform.position - origin).flat()
            ahead = offset.dot(facing)
            across = (offset - facing * ahead).length()
            if health.dead or ahead < 0 or across > spec.width + ahead * spec.spread:
                continue
            health.damage(power, source=self.entity, kind=spec.kind)
            ctx.emit(Staggered(entity=foe, seconds=spec.stagger))
            hits += 1
        for step in range(1, 8):
            ctx.vfx.play(spec.effect, at=origin + facing * step + vec3(0, 0.6, 0))
        ctx.camera.main.shake(0.09, 0.13)
        if hits == 0:
            hint(ctx, ctx.text(Text.wave_missed))

    def mend(self, ctx, spec: AbilityDef):
        self.entity.get(Health).heal(spec.heal)
        ctx.vfx.play(spec.effect, at=self.entity.transform.position + vec3(0, 0.7, 0))
        hint(ctx, ctx.text(Text.mend_healed, amount=round(spec.heal)))
