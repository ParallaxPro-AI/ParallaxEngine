from parallax import Context, SceneLoaded, System, on, system

from game.content import KitchenSounds, ServiceRules
from game.resources import Record, Result, Service, cooking
from game.rules import kitchen, play, time_left


@system("service_clock", when=cooking)
class ServiceClock(System):
    """The campaign: three kitchens, each with a clock and a team target. Hit the
    target before time runs out and the next kitchen loads with your scores carried
    over (its clock is scene time, and the streak and rail are `keep="scene"`, so
    they start over by themselves); miss it and service is over. Clear the last
    kitchen and you've won."""

    @on(SceneLoaded)
    def open_kitchen(self, ctx, event):
        service = ctx.get(Service)
        if service.best_at_start < 0:
            # The record this campaign has to beat for the results card's New Best stamp.
            service.best_at_start = ctx.get(Record).best_score

    def update(self, ctx, dt):
        if time_left(ctx) <= 0:
            self.close_kitchen(ctx, ctx.get(Service))

    def close_kitchen(self, ctx: Context, service: Service) -> None:
        campaign = ctx.config(ServiceRules).kitchens
        record = ctx.get(Record)
        total = sum(service.scores)
        record.best_score = max(record.best_score, total)
        record.best_streak = max(record.best_streak, service.best_streak)

        cleared = total >= kitchen(ctx).target
        if cleared:
            record.kitchens_cleared = max(record.kitchens_cleared, service.kitchen + 1)
        if cleared and service.kitchen < len(campaign) - 1:
            service.kitchen += 1
            play(ctx, ctx.config(KitchenSounds).level_clear)
            ctx.scenes.load(campaign[service.kitchen].data.scene)
            return
        record.rounds_played += 1
        service.result = Result.WON if cleared else Result.LOST
        sounds = ctx.config(KitchenSounds)
        play(ctx, sounds.victory if cleared else sounds.game_over)
