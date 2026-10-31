from parallax import Animator, Behavior, behavior, on
from parallax.combat import Health
from parallax.nav import NavAgent

from features.abilities.effects import cast_ability
from features.fighting.feature import Animations
from features.heroes.feature import AbilityBook, CastRequested, Mana, Progression, RankUpRequested, rank_cap
from game.audio import Sounds, excite, play
from game.content import AbilityKind, CastAnimation


@behavior("ability_caster", requires=[AbilityBook, Mana, Progression, Health, Animations, Animator])
class AbilityCaster(Behavior):
    """Casts a champion's abilities for whoever asks: the player's keys, a bot,
    or the ability bar. It checks rank, cooldown and mana, pays, plays the cast
    animation, then runs the ability's effect at the aim point. It also spends
    skill points on ranks, within the level's rank cap."""

    @on(CastRequested)
    def cast(self, ctx, event: CastRequested):
        book = self.entity.get(AbilityBook)
        mana = self.entity.get(Mana)
        ability = book.abilities[event.slot].data
        rank = book.ranks[event.slot]
        cost = ability.mana.at(rank)
        if (self.entity.get(Health).dead or rank == 0
                or ctx.time.now < book.ready_at[event.slot] or mana.current < cost):
            return
        mana.current -= cost
        book.ready_at = _with(book.ready_at, event.slot, ctx.time.now + ability.cooldown.at(rank))
        self.entity.get(NavAgent).stop()
        clips = self.entity.get(Animations).clips
        self.entity.get(Animator).play_once(clips.cast if ability.animation is CastAnimation.CAST else clips.attack)
        sounds = ctx.config(Sounds)
        play(ctx, (sounds.cast_q, sounds.cast_w, sounds.cast_e, sounds.cast_r)[event.slot], self.entity)
        excite(ctx, 0.12)
        if ability.kind is AbilityKind.HEAL:
            play(ctx, sounds.cast_heal, self.entity)
            excite(ctx, 0.06)
        if ability.cast_time:
            ctx.time.after(ability.cast_time, lambda: cast_ability(ctx, self.entity, ability, rank, event.aim))
        else:
            cast_ability(ctx, self.entity, ability, rank, event.aim)

    @on(RankUpRequested)
    def rank_up(self, ctx, event: RankUpRequested):
        book = self.entity.get(AbilityBook)
        progression = self.entity.get(Progression)
        cap = rank_cap(ctx, book.abilities[event.slot].data, progression.level)
        if progression.skill_points == 0 or book.ranks[event.slot] >= cap:
            return
        book.ranks = _with(book.ranks, event.slot, book.ranks[event.slot] + 1)
        progression.skill_points -= 1
        if self.entity.owner is not None:
            play(ctx, ctx.config(Sounds).rank_up, to=self.entity.owner)


def _with(values: list, index: int, value) -> list:
    """A copy of `values` with one entry replaced (replicated lists are reassigned whole)."""
    changed = list(values)
    changed[index] = value
    return changed
