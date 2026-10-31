"""The waves of one battlefield, start to finish."""

import math
import random

from parallax import SceneLoaded, System, Vec3, clamp, on, system, vec3
from parallax.combat import Damaged, Died, Health
from project import Assets, Text

from game.battlefield import current_battlefield, ground_y
from game.components import BattlefieldScene, EnemyTank, PlayerTank
from game.config import BattleRules
from game.content import BattlefieldDef, UpgradeDef, WaveDef
from game.loadout import apply_upgrade
from game.resources import BattleState, Campaign, Career, Loadout, Phase, announce


@system("battle", scenes=[BattlefieldScene])
class Battle(System):
    """Runs a battlefield as one script: for each wave, a countdown, then the tanks roll
    in around the player, then a short breather once the last hull burns. A wave with
    no hits taken scores a flawless bonus. Clearing the battlefield grants its reward
    and opens the field workshop, or wins the campaign on the finale. Losing the hull
    ends the run. The script ends with the scene (quit or retry mid-wave)."""

    @on(SceneLoaded)
    def roll_out(self, ctx, event):
        ctx.run(self.fight)

    async def fight(self, ctx, task):
        state, rules = ctx.get(BattleState), ctx.config(BattleRules)
        battlefield = current_battlefield(ctx)
        for number, wave in enumerate(battlefield.waves, start=1):
            state.wave, state.phase, state.flawless = number, Phase.COUNTDOWN, True
            announce(ctx, ctx.text(Text.wave_number, number=number), self.describe(ctx, wave.data), "info", rules.countdown)
            await task.seconds(rules.countdown)
            state.phase = Phase.FIGHTING
            announce(ctx, ctx.text(Text.engage), style="warn", hold=1.2)
            self.spawn_wave(ctx, battlefield, wave.data)
            await task.until_true(lambda: ctx.world.query(EnemyTank).count() == 0)
            state.phase = Phase.CLEARED
            if state.flawless:
                ctx.get(Campaign).score += rules.flawless_bonus
                ctx.ui.toast(ctx.text(Text.flawless, bonus=rules.flawless_bonus))
            announce(ctx, ctx.text(Text.wave_clear), self.clear_subtitle(ctx, battlefield, number), "success", 2.5)
            await task.seconds(rules.wave_clear_pause)
        self.battlefield_cleared(ctx, battlefield)

    def describe(self, ctx, wave: WaveDef) -> str:
        groups = " + ".join(f"{group.count} {group.tank.id}" for group in wave.groups)  # the template names the tier id: "4 light"
        return f"{ctx.text(current_battlefield(ctx).name)} — {groups}"

    def clear_subtitle(self, ctx, battlefield: BattlefieldDef, number: int):
        if number < len(battlefield.waves):
            return Text.next_assault
        if battlefield.next is None:
            return Text.all_hostiles
        return battlefield.reward.data.description if battlefield.reward is not None else Text.advancing

    def spawn_wave(self, ctx, battlefield: BattlefieldDef, wave: WaveDef):
        rules = ctx.config(BattleRules)
        center = ctx.world.query(tagged=PlayerTank).single().transform.position
        edge = rules.map_half - 6
        tanks = [group.tank for group in wave.groups for _ in range(group.count)]
        for index, kind in enumerate(tanks):
            heading = index / len(tanks) * 360 + random.uniform(0, 28.6)
            spot = center + Vec3.from_yaw_pitch(heading, length=rules.spawn_ring * random.uniform(0.5, 0.71))
            health = kind.data.health * battlefield.hp_mul
            spot = vec3(clamp(spot.x, -edge, edge), 0, clamp(spot.z, -edge, edge))
            ctx.world.spawn(
                kind.data.prefab,
                at=spot.with_y(ground_y(ctx, spot) + kind.data.ride),
                components=[EnemyTank(kind=kind, flank=random.choice([-1, 1])), Health(current=health, max=health)],
            )

    @on(Damaged, where=lambda event: event.entity.has(PlayerTank))
    def hull_hit(self, ctx, event):
        ctx.get(BattleState).flawless = False

    @on(Died, where=lambda event: event.entity.has(PlayerTank))
    def hull_lost(self, ctx, event):
        ctx.vfx.play(Assets.vfx.tank_explosion, at=event.entity)
        self.finish(ctx, won=False)

    def battlefield_cleared(self, ctx, battlefield: BattlefieldDef):
        loadout = ctx.get(Loadout)
        if battlefield.reward is not None:
            apply_upgrade(loadout, battlefield.reward)
            ctx.ui.toast(battlefield.reward.data.description, seconds=4)
        if battlefield.next is None:
            _, hull = ctx.world.query(Health, tagged=PlayerTank).single()
            ctx.get(Campaign).score += math.floor(hull.current)
            self.finish(ctx, won=True)
            return
        state, rules = ctx.get(BattleState), ctx.config(BattleRules)
        deck = [card for card in ctx.content(UpgradeDef) if card.data.offered and card not in loadout.picks]
        state.offer = random.sample(deck, min(rules.upgrade_offers, len(deck)))
        state.offer_expires_at = ctx.time.real_now + rules.upgrade_auto_pick
        state.phase = Phase.WORKSHOP

    def finish(self, ctx, won: bool):
        career = ctx.get(Career)
        ctx.get(BattleState).phase = Phase.WON if won else Phase.LOST
        career.best_score = max(career.best_score, ctx.get(Campaign).score)
        if won:
            career.victories += 1
            career.furthest, career.build = None, []
