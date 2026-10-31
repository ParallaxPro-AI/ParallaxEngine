import random

from parallax import Context, ContentRef, System, on, system, vec3
from project import Assets, Scenes

from game.components import Build
from game.content import UpgradeDef
from game.effects import apply_effect
from game.events import XpGained
from game.resources import Draft, Run
from game.rules import Rules, play, scales, survivor, xp_to_level


@system("leveling", scenes=[Scenes.arena])
class Leveling(System):
    """Soul motes become XP. Each level-up deals a draft of upgrades (weighted, never a
    card you've maxed); the draft panel is open and the fight frozen while a hand is
    dealt. Two levels at once queue two drafts. The panel's buttons are `pick_upgrade`
    and `reroll`."""

    @on(XpGained)
    def gained(self, ctx, event: XpGained):
        run = ctx.get(Run)
        run.xp += event.amount * survivor(ctx).get(Build).xp_mul
        while run.xp >= xp_to_level(ctx):
            run.xp -= xp_to_level(ctx)
            run.level += 1
            run.pending_drafts += 1
            run.score += ctx.config(Rules).level_points * scales(ctx).score
        draft = ctx.get(Draft)
        if run.pending_drafts and not draft.cards:
            draft.cards = draw(ctx, draft)
            ctx.vfx.play(Assets.vfx.level_up, at=survivor(ctx).transform.position + vec3(0, 0.4, 0))
            play(ctx, ctx.config(Rules).sounds.level_up)


def draw(ctx: Context, draft: Draft) -> list[ContentRef[UpgradeDef]]:
    """A fresh hand, weighted, without repeats or cards already taken to their limit."""
    pool = [card for card in ctx.content(UpgradeDef) if draft.stacks.get(card, 0) < card.data.max_stacks]
    hand = []
    while pool and len(hand) < ctx.config(Rules).draft_choices:
        card = random.choices(pool, weights=[c.data.weight for c in pool])[0]
        hand.append(card)
        pool.remove(card)
    return hand


def pick_upgrade(ctx: Context, upgrade: ContentRef[UpgradeDef]) -> None:
    """The draft panel's card action: take the card, then deal the next queued hand."""
    draft = ctx.get(Draft)
    if upgrade not in draft.cards:
        return
    draft.stacks[upgrade] = draft.stacks.get(upgrade, 0) + 1
    apply_effect(ctx, upgrade.data.effect)
    play(ctx, ctx.config(Rules).sounds.draft)
    run = ctx.get(Run)
    run.pending_drafts -= 1
    draft.cards = draw(ctx, draft) if run.pending_drafts else []


def reroll(ctx: Context) -> None:
    """The draft panel's Redeal button: a new hand for one reroll."""
    draft = ctx.get(Draft)
    if draft.rerolls == 0:
        play(ctx, ctx.config(Rules).sounds.denied)
        return
    draft.rerolls -= 1
    draft.cards = draw(ctx, draft)
    play(ctx, ctx.config(Rules).sounds.reroll)
