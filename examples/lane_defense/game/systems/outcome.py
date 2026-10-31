"""The house, the score, and how a level ends."""

from parallax import Context, SceneLoaded, System, on, system
from parallax.combat import Died
from project import Assets, Scenes, Text

from game.checkpoint import clear_checkpoint
from game.components import Husk
from game.config import GardenRules
from game.events import HuskReachedHouse
from game.lawn import current_level, husk_count
from game.notes import HINT_SECONDS, announce, say
from game.resources import Campaign, GardenState, Result, WaveState
from game.audio import Sounds, play


def playing(ctx: Context) -> bool:
    """The level is neither won nor lost yet."""
    return ctx.get(GardenState).result is Result.PLAYING


@system("outcome", scenes=[Scenes.garden], when=playing)
class Outcome(System):
    """Husks that reach the house hurt it; routed husks pay their bounty. The level is
    lost when the house falls and won when the last wave is spawned and routed. Stars
    (by house health left) and the best score are kept on the profile. The result
    screen follows `GardenState.result`."""

    @on(SceneLoaded)
    def show_hint(self, ctx, event):
        say(ctx, ctx.text(current_level(ctx).hint), HINT_SECONDS)

    @on(HuskReachedHouse, when=playing)
    def house_hit(self, ctx, event):
        garden = ctx.get(GardenState)
        garden.house_health = max(0, garden.house_health - ctx.config(GardenRules).leak_damage)
        announce(ctx, ctx.text(Text.notice_husk_got_through, row=event.husk.get(Husk).lane + 1), danger=True)
        if garden.house_health == 0:
            self.finish(ctx, won=False)

    @on(Died, when=playing, where=lambda event: event.entity.has(Husk))
    def husk_routed(self, ctx, event):
        garden = ctx.get(GardenState)
        garden.kills += 1
        garden.score += event.entity.get(Husk).kind.data.bounty
        ctx.vfx.play(Assets.vfx.husk_poof, at=event.entity.transform.position.with_y(0.7))
        play(ctx, ctx.config(Sounds).husk_die)

    def update(self, ctx, dt):
        level, waves = current_level(ctx), ctx.get(WaveState)
        all_spawned = waves.wave == len(level.waves) and waves.spawned == husk_count(level, level.waves[-1])
        if all_spawned and ctx.world.query(Husk).count() == 0:
            self.finish(ctx, won=True)

    def finish(self, ctx, won: bool):
        garden, campaign = ctx.get(GardenState), ctx.get(Campaign)
        garden.result = Result.WON if won else Result.LOST
        clear_checkpoint(ctx)
        if won:
            garden.stars = self.stars_for(ctx, garden.house_health)
            campaign.stars[campaign.level] = max(campaign.stars.get(campaign.level, 0), garden.stars)
        campaign.best_score = max(campaign.best_score, garden.score)
        play(ctx, ctx.config(Sounds).win if won else ctx.config(Sounds).lose)

    def stars_for(self, ctx, house_health: int) -> int:
        rules = ctx.config(GardenRules)
        if house_health >= rules.three_star_health:
            return 3
        return 2 if house_health >= rules.two_star_health else 1
