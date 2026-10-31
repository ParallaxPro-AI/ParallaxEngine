import math
import random

from parallax import Context, System, clamp, on, system
from project import Text

from game.content import KitchenSounds, ServiceRules
from game.events import DishServed, FoodBinned, StepDone
from game.resources import Orders, Service, Ticket
from game.rules import kitchen, penalize, play, tell


@system("order_rail")
class OrderRail(System):
    """Customers' tickets: a new one every few seconds from this kitchen's menu,
    each expiring if nobody serves it. A served dish pays its price, plus the team's
    running streak, plus a bonus for serving a fresh ticket. Serving something
    nobody ordered costs points and breaks the streak; bin mistakes instead."""

    def update(self, ctx, dt):
        orders, service = ctx.get(Orders), ctx.get(Service)
        orders.next_in -= dt
        if orders.next_in <= 0:
            orders.next_in = kitchen(ctx).order_interval
            self.place_order(ctx, orders)
        for ticket in list(orders.tickets):
            ticket.time_left -= dt
            if ticket.time_left <= 0:
                orders.tickets.remove(ticket)
                service.missed += 1
                service.streak = 0
                service.missed_at = ctx.time.now
                play(ctx, ctx.config(KitchenSounds).wrong, gain=0.7)

    def place_order(self, ctx: Context, orders: Orders) -> None:
        scoring = ctx.config(ServiceRules)
        if len(orders.tickets) >= scoring.max_orders:
            return
        lifetime = scoring.order_lifetime
        orders.printed += 1
        orders.tickets.append(Ticket(dish=random.choice(kitchen(ctx).menu), number=orders.printed,
                                     time_left=lifetime, lifetime=lifetime))
        play(ctx, ctx.config(KitchenSounds).order_new)

    @on(DishServed)
    def serve(self, ctx, event):
        orders, service, scoring = ctx.get(Orders), ctx.get(Service), ctx.config(ServiceRules)
        chef = event.by.owner
        ticket = next((t for t in orders.tickets if t.dish.data.item == event.item), None)
        if ticket is None:
            service.streak = 0
            penalize(ctx, chef, scoring.wrong_dish_penalty)
            play(ctx, ctx.config(KitchenSounds).wrong)
            tell(ctx, event.by, ctx.text(Text.nobody_ordered, penalty=scoring.wrong_dish_penalty), bad=True)
            return

        orders.tickets.remove(ticket)
        service.streak = min(service.streak + 1, scoring.streak_cap)
        service.best_streak = max(service.best_streak, service.streak)
        service.served += 1
        combo = (service.streak - 1) * scoring.streak_bonus
        fresh = math.floor(scoring.speed_bonus * clamp(ticket.time_left / ticket.lifetime, 0, 1))
        points = ticket.dish.data.points + combo + fresh
        service.scores[chef.index] += points
        play(ctx, ctx.config(KitchenSounds).delivery)
        detail = ctx.text(Text.served, dish=ctx.text(ticket.dish.data.name), points=points)
        if combo > 0:
            detail += "   " + ctx.text(Text.served_combo, streak=service.streak)
        if fresh > 0:
            detail += "   " + ctx.text(Text.served_fast, bonus=fresh)
        tell(ctx, event.by, detail)

    @on(FoodBinned)
    def binned(self, ctx, event):
        ctx.get(Service).binned += 1

    @on(StepDone)
    def step_done(self, ctx, event):
        ctx.get(Service).prep_actions += 1
