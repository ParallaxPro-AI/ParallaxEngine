import random

from parallax import Context, Entity, System, Tag, Vec3, system, vec3
from parallax.characters import Character

from game.components import Ball, Bot, Flight, Throw
from game.content import BotStyle, CourtRules
from game.events import PassAttempted, ShotReleased, StealAttempted, Zone
from game.resources import playing
from game.rules import hoop_defended_by, nearest_opponent_distance, rival, run_to, team_of, teammates


@system("court_tactics", when=playing)
class CourtTactics(System):
    """The three bots: your running mate and the two-man crew.

    On offense the carrier drives to a shooting spot and lets it go when open (or
    when the shot clock is dying), swinging it to the open man when covered; the
    other attacker spaces to the wing. On defense it's man-to-man, not a swarm:
    whoever is closest to the carrier picks him up, counting YOU, and the other
    defender sags into the paint. Everybody crashes a missed shot's rim and races
    for a loose ball. Bots ask for shots, passes and steals with the same events
    your buttons send."""

    def update(self, ctx, dt):
        ball_entity, ball = ctx.world.query(Ball).single()
        flight = ball_entity.try_get(Flight)
        on_ball_defender = self.on_ball_defender(ctx, ball.holder)
        for bot_entity, bot, character in ctx.world.query(Bot, Character):
            bot.steal_ready_in = max(0.0, bot.steal_ready_in - dt)
            if flight is not None:
                self.in_flight(ctx, character, flight)
            elif ball.holder is None:
                run_to(ctx, character, ball.rest)
            elif ball.holder == bot_entity:
                self.carry(ctx, bot_entity, bot.style, character, ball, dt)
            elif team_of(ball.holder) is team_of(bot_entity):
                run_to(ctx, character, self.wing_spot(ctx, bot_entity, ball.holder))
            elif bot_entity == on_ball_defender:
                self.guard(ctx, bot_entity, bot, character, ball.holder)
            else:
                run_to(ctx, character, self.paint_spot(ctx, team_of(bot_entity), ball.holder))

    def in_flight(self, ctx: Context, character: Character, flight: Flight) -> None:
        """Crash the rim on a shot; hold your spot while a pass is in the air."""
        if flight.kind is Throw.SHOT:
            run_to(ctx, character, flight.end)
        else:
            character.stop()

    def carry(self, ctx: Context, carrier: Entity, style: BotStyle, character: Character,
              ball: Ball, dt: float) -> None:
        court = ctx.config(CourtRules)
        rim = hoop_defended_by(ctx, rival(team_of(carrier)))
        at = carrier.transform.position
        to_rim = at.flat().distance_to(rim.flat())
        covered = nearest_opponent_distance(ctx, carrier) <= court.contest_range
        if to_rim <= style.shoot_range and (not covered or ball.shot_clock < court.late_clock):
            ctx.emit(ShotReleased(shooter=carrier, zone=self.roll_zone(style)))
            return
        if covered and random.random() < style.pass_chance * court.pass_urgency * dt:
            ctx.emit(PassAttempted(passer=carrier))
            return
        # Drive to a shooting spot, not into the rim: parking under the basket
        # turns every possession into point-blank putbacks.
        depth = max(court.min_drive_depth, style.shoot_range * court.drive_depth)
        run_to(ctx, character, rim.flat() + (at - rim).flat().normalized() * depth)

    def roll_zone(self, style: BotStyle) -> Zone:
        roll = random.random()
        if roll < style.perfect_rate:
            return Zone.GREEN
        if roll < style.perfect_rate + style.good_rate:
            return Zone.YELLOW
        return Zone.MISS

    def on_ball_defender(self, ctx: Context, carrier: Entity | None) -> Entity | None:
        """The defender closest to the carrier, human or bot."""
        if carrier is None:
            return None
        return ctx.world.query(tagged=rival(team_of(carrier))).nearest(carrier.transform.position)

    def guard(self, ctx: Context, defender: Entity, bot: Bot, character: Character, carrier: Entity) -> None:
        """Arm's length off the carrier (walking into him just shoves him), poking
        at the ball every few seconds; tighter crews reach in more often."""
        court = ctx.config(CourtRules)
        at, carrier_at = defender.transform.position, carrier.transform.position
        run_to(ctx, character, carrier_at + (at - carrier_at).flat().normalized() * court.guard_standoff)
        if bot.steal_ready_in == 0 and at.distance_to(carrier_at) <= court.steal_range:
            bot.steal_ready_in = max(court.min_bot_steal_interval, court.bot_steal_interval / bot.style.close_pressure)
            ctx.emit(StealAttempted(by=defender))

    def paint_spot(self, ctx: Context, team: Tag, carrier: Entity) -> Vec3:
        """Sag off the man without the ball toward the rim you defend. A chaser can
        never close on someone running as fast as him, so this is what stops layups."""
        court = ctx.config(CourtRules)
        rim = hoop_defended_by(ctx, team).flat()
        off_ball = next(p for p in teammates(ctx, rival(team)) if p != carrier)
        offset = off_ball.transform.position.flat() - rim
        return rim + offset.normalized() * min(court.paint_depth, offset.length() / 2)

    def wing_spot(self, ctx: Context, mate: Entity, carrier: Entity) -> Vec3:
        """Space the floor: the wing on your side, or the other one if the carrier is in your lane."""
        court = ctx.config(CourtRules)
        rim = hoop_defended_by(ctx, rival(team_of(mate)))
        toward_centre = -1 if rim.x > 0 else 1
        side = 1 if mate.transform.position.z >= 0 else -1
        z = side * court.open_spread
        if abs(carrier.transform.position.z - z) < court.lane_width:
            z = -z
        return vec3(rim.x + toward_centre * court.open_spread, 0, z)
