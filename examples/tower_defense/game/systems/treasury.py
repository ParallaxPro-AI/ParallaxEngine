"""Gold and lives."""

import math

from parallax import Color, System, on, system, vec3
from parallax.combat import Died
from project import Text

from game.audio import Sounds
from game.components import BattlefieldScene, Invader
from game.config import SiegeRules
from game.events import EnemyLeaked, WaveCleared
from game.resources import Purse, Siege
from game.siege import current_level

GOLD = Color.hex("#fbbf24")


@system("treasury", scenes=[BattlefieldScene])
class Treasury(System):
    """Kills pay a bounty. A cleared wave pays a bonus, more for a boss, plus interest on
    the gold still banked and a bonus for letting nothing through. That's what makes
    saving gold a real choice. Leaks cost lives, and lives only go down. (The purse
    starts full: `battlefield_map.battle` loads the scene with it.)"""

    @on(Died, where=lambda event: event.entity.has(Invader))
    def bounty(self, ctx, event):
        invader = event.entity.get(Invader)
        reward = math.floor(invader.kind.data.reward * current_level(ctx).bounty_mul)
        ctx.get(Purse).gold += reward
        ctx.ui.float_text(f"+{reward}", event.entity.transform.position + vec3(0, 0.7, 0), color=GOLD)
        ctx.audio.play(ctx.config(Sounds).enemy_die, at=event.entity, volume=0.25)

    @on(EnemyLeaked)
    def leak(self, ctx, event):
        cost = event.enemy.get(Invader).kind.data.lives_cost
        purse = ctx.get(Purse)
        purse.lives = max(0, purse.lives - cost)
        ctx.get(Siege).leaked_this_wave = True
        ctx.camera.main.shake(0.35, 0.26)
        ctx.ui.toast(ctx.text(Text.lives_lost, lives=cost))
        ctx.audio.play(ctx.config(Sounds).enemy_leak, volume=0.4)

    @on(WaveCleared)
    def payout(self, ctx, event):
        rules, purse = ctx.config(SiegeRules), ctx.get(Purse)
        interest = min(rules.interest_cap, math.floor(purse.gold * rules.interest_rate))
        bonus = rules.clear_bonus + rules.clear_bonus_per_wave * event.number
        if event.boss:
            bonus = math.floor(bonus * rules.boss_bonus_mul)
        clean = 0 if ctx.get(Siege).leaked_this_wave else rules.no_leak_bonus
        purse.gold += interest + bonus + clean
        ctx.ui.toast(ctx.text(Text.wave_payout, bonus=bonus, interest=interest, clean=clean))
        ctx.audio.play(ctx.config(Sounds).bonus_gold, volume=0.4)
