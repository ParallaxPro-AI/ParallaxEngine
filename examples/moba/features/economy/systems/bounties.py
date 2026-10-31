from parallax import Color, Entity, System, Vec3, on, system
from parallax.combat import Died, Side
from project import Text

from features.economy.components import Bounty, Wallet
from features.fighting.feature import add_stats
from features.heroes.feature import Hero, Progression, grant_xp
from game.components import Blue
from game.audio import Sounds, excite, play
from game.config import MatchRules
from game.resources import Match, announce, log_kill

GOLD = Color.hex("#f5c542")


@system("bounties")
class Bounties(System):
    """Pays for kills. Everything goes to the champion who lands the last hit:
    minions, camps and towers pay their Bounty, and a champion pays a bounty that
    grows with the victim's level and kill streak, plus a bonus for the match's
    opening kill. Ending a streak is worth more than starting one. A camp's reward
    joins the killer's permanent stats."""

    @on(Died)
    def killed(self, ctx, event: Died):
        victim, killer = event.entity, event.source
        champion_killer = killer if killer and killer.has(Hero) else None
        if victim.has(Hero):
            self._champion_down(ctx, victim, champion_killer)
        bounty = victim.try_get(Bounty)
        if bounty and champion_killer:
            _pay(ctx, champion_killer, bounty.gold, bounty.xp, victim.transform.position)
            if champion_killer.owner is not None and not victim.has(Hero):
                play(ctx, ctx.config(Sounds).last_hit, to=champion_killer.owner)
                excite(ctx, 0.01)
            if bounty.announcement:
                hero = champion_killer.get(Hero)
                hero.earned = hero.earned + bounty.reward
                add_stats(champion_killer, hero.earned, key="jungle")
                name = ctx.text(hero.champion.data.name)
                announce(ctx, ctx.text(bounty.announcement, champion=name), "success", small=True)
                log_kill(ctx, name, ctx.text(Text.feed_camp), champion_killer.get(Side).side, None)
                excite(ctx, 0.15)

    def _champion_down(self, ctx, victim: Entity, killer: Entity | None):
        rules = ctx.config(MatchRules)
        fallen = victim.get(Hero)
        fallen.deaths += 1
        bounty = (rules.champion_bounty + rules.bounty_per_level * (victim.get(Progression).level - 1)
                  + min(rules.max_streak_bonus, rules.streak_bonus * fallen.streak))
        fallen.streak = 0
        if killer is None:
            return
        match = ctx.get(Match)
        hero = killer.get(Hero)
        name = ctx.text(hero.champion.data.name)
        side = killer.get(Side).side
        victim_name = ctx.text(fallen.champion.data.name)
        log_kill(ctx, name, victim_name, side, victim.get(Side).side)
        announce(ctx, ctx.text(Text.slew, killer=name, victim=victim_name), "kill", side=side, small=True)
        if not match.opening_strike_taken:
            match.opening_strike_taken = True
            bounty += rules.opening_strike_bonus
            announce(ctx, ctx.text(Text.opening_strike, champion=name))
            play(ctx, ctx.config(Sounds).vo_first_blood)
        hero.kills += 1
        hero.streak += 1
        if side == Blue:
            match.blue_kills += 1
        else:
            match.red_kills += 1
        if hero.streak < len(rules.streak_names) and rules.streak_names[hero.streak]:
            announce(ctx, ctx.text(rules.streak_names[hero.streak], champion=name))
            play(ctx, ctx.config(Sounds).vo_streak)
        _pay(ctx, killer, round(bounty), rules.champion_xp, victim.transform.position)


def _pay(ctx, hero: Entity, gold: int, xp: float, at: Vec3):
    hero.get(Wallet).gold += gold
    grant_xp(ctx, hero, xp)
    if gold and hero.owner:
        ctx.ui.float_text(f"+{gold}", at, color=GOLD, to=hero.owner)
