"""The escape: count-in, distance, districts and how a run ends."""

from parallax import System, on, system
from project import Scenes, Text

from game.audio import Sounds, play
from game.components import Runner
from game.config import Rules
from game.content import DistrictDef
from game.events import CoinsEarned, DistrictEntered, RunEnded
from game.resources import Run, running
from game.systems.lockup import apply_upgrades, keep_records


async def count_in(ctx, task):
    """Three, two, one, go: announced and beeped a second apart."""
    for count in range(ctx.config(Rules).countdown, 0, -1):
        ctx.ui.announce(str(count), seconds=0.8)
        play(ctx, ctx.config(Sounds).count_beep)
        await task.seconds(1)
    ctx.ui.announce(Text.announce_go, ctx.get(Run).district.data.name)
    play(ctx, ctx.config(Sounds).go)


@system("escape", scenes=[Scenes.street], when=running)
class Escape(System):
    """Owns the run's arc. A count-in holds everyone still; then distance is how
    far down the street the runner has got. Crossing a district's end line
    hands over to the next district (faster, tighter, meaner, and fogged in its
    own colour). Clearing the last one is the escape, and the win; in Night
    Shift the districts loop forever. The other ending, being caught, comes from
    the chase. Either way the run's records are kept and the end card opens a
    beat later. Only the first `RunEnded` counts: a winning stride and a last
    hit can land on the same frame."""

    def start(self, ctx):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.hold_until = ctx.time.now + rules.countdown
        run.gap_max = rules.guard_follow
        apply_upgrades(ctx)
        run.guard_gap = run.gap_max
        ctx.run(count_in)

    def update(self, ctx, dt):
        run = ctx.get(Run)
        runner, _ = ctx.world.query(Runner).single()
        run.distance = max(run.distance, runner.transform.position.z)
        self.advance_district(ctx, run)

    def advance_district(self, ctx, run: Run):
        districts = ctx.content(DistrictDef)
        lap_length = districts[-1].data.end_distance
        if run.distance < run.district.data.end_distance + lap_length * run.lap:
            return
        following = districts.next(run.district)
        if following:
            run.district = following
        elif run.endless:
            run.district, run.lap = districts[0], run.lap + 1
        else:
            ctx.emit(RunEnded(won=True))
            return
        ctx.emit(DistrictEntered(district=run.district))

    @on(DistrictEntered)
    def entered(self, ctx, event: DistrictEntered):
        district = event.district.data
        play(ctx, ctx.config(Sounds).district)
        ctx.ui.announce(district.name, district.blurb, seconds=3)
        ctx.environment.fog(
            near=district.fog_near,
            far=district.fog_far,
            color=district.fog_color,
            seconds=ctx.config(Rules).district_fog_blend,
        )

    @on(RunEnded, when=running)
    def ended(self, ctx, event: RunEnded):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.over, run.won = True, event.won
        run.card_at = ctx.time.now + rules.end_card_delay
        ctx.audio.music(None)
        if event.won:
            run.coins += rules.escape_bonus
            ctx.emit(CoinsEarned(amount=rules.escape_bonus))
            play(ctx, ctx.config(Sounds).escaped)
        else:
            play(ctx, ctx.config(Sounds).busted)
        keep_records(ctx, won=event.won)
