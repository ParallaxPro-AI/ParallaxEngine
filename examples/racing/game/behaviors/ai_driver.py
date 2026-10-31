from parallax import Behavior, angle_between, behavior, clamp, heading_to, param, state, wrap_angle
from parallax.vehicles import Vehicle

from game.components import Racer
from game.rules import is_racing, put_back_on_track, racing_line
from game.track import flat_distance, gate


@behavior("ai_driver", when=is_racing)
class AiDriver(Behavior):
    """Drives a rival car round the racing line like a careful human on real tyres.

    It reads the corner one gate ahead and brakes to a corner speed BEFORE turning in,
    ramps the wheel instead of snapping it (less lock the faster it goes), unwinds and
    lifts when the car slides, and reverses out when it gets beached on the scenery; rolled
    over, beached past three back-outs, or crawling for `stalled_after` seconds, it is put
    back on the line like the player.
    LapCounting moves it on to the next gate; it only ever steers at that gate. Once
    its own car has finished it holds the brakes."""

    speed_scale: float = param(1.0, min=0.1, doc="Set per difficulty when the grid is built.")
    cruise_fraction: float = param(0.9, min=0, max=1, doc="Share of top speed it holds on the straights.")
    corner_slowdown: float = param(0.62, min=0, max=1, doc="Speed shed for a 90° corner.")
    min_corner_speed: float = param(11, unit="m/s")
    short_leg: float = param(40, unit="m", doc="A gate this close with a bend after it means brake now.")
    short_leg_speed: float = param(0.55, min=0, max=1)
    brake_margin: float = param(6, unit="m/s", doc="Over corner speed by this much: brake, not coast.")
    brake_range: float = param(14, unit="m/s", doc="Overspeed that means full brakes.")
    full_lock_angle: float = param(24, unit="deg", doc="Bearing error that asks for full lock.")
    steer_rate: float = param(4, unit="1/s")
    lock_fade_speed: float = param(90, unit="m/s")
    min_lock: float = param(0.45, min=0, max=1, doc="Steering authority kept at any speed.")
    stuck_speed: float = param(1.5, unit="m/s")
    stuck_after: float = param(2, unit="s")
    launch_grace: float = param(4, unit="s", doc="No stuck checks this long after the start.")
    progress_step: float = param(0.15, unit="m/s", doc="Speed gained that proves it is not stuck.")
    reverse_for: float = param(1.2, unit="s")
    reverse_throttle: float = param(0.45, min=0, max=1)
    reverse_max_speed: float = param(4, unit="m/s")
    recover_for: float = param(3, unit="s", doc="Protected forward launch after reversing.")
    free_speed: float = param(6, unit="m/s", doc="Speed that proves a back-out worked (a nudge into the same wall does not).")
    overturned_after: float = param(1.5, unit="s", doc="On its side or roof this long: back on the line.")
    give_up_after: int = param(3, min=1, doc="Failed back-outs in a row before it is put back on the line.")
    stalled_after: float = param(8, unit="s", doc="Under free_speed this long, back-outs and all: back on the line.")

    steer: float = state(0.0)
    racing_for: float = state(0.0)
    slow_for: float = state(0.0)
    slow_peak: float = state(0.0)
    reversing: float = state(0.0)
    recovering: float = state(0.0)
    overturned_for: float = state(0.0)
    back_outs: int = state(0)
    stalled_for: float = state(0.0)

    def update(self, ctx, dt):
        car = self.entity.parent
        vehicle = car.get(Vehicle)
        if car.get(Racer).finish_place:
            vehicle.drive(brake=1)
            return
        self.racing_for += dt

        line = racing_line(ctx)
        passed = car.get(Racer).gates_passed
        here, target, after = car.transform.position, gate(line, passed), gate(line, passed + 1)
        bearing = wrap_angle(heading_to(here, target) - car.transform.euler.y)
        speed = vehicle.speed

        # Rolled over, or beached past backing out: the player's respawn, for the AI.
        self.overturned_for = self.overturned_for + dt if car.transform.up.y < 0.4 else 0.0
        crawling = self.racing_for > self.launch_grace and abs(speed) < self.free_speed
        self.stalled_for = self.stalled_for + dt if crawling else 0.0
        if self.overturned_for > self.overturned_after or self.back_outs >= self.give_up_after or self.stalled_for > self.stalled_after:
            self.overturned_for, self.back_outs, self.stalled_for = 0.0, 0, 0.0
            self.reversing = self.recovering = 0.0
            put_back_on_track(ctx, car)
            return

        if self.reversing > 0:
            self.back_out(vehicle, speed, dt)
        elif speed < -0.25 and self.recovering == 0:
            self.recovering = self.recover_for
            vehicle.drive(brake=1)
        elif self.recovering > 0:
            self.pull_away(vehicle, bearing, speed, dt)
        elif self.is_stuck(speed, dt):
            self.reversing = self.reverse_for
            self.back_outs += 1
        else:
            self.race(vehicle, bearing, speed, flat_distance(here, target),
                      angle_between((target - here).flat(), (after - target).flat()), dt)

    def race(self, vehicle, bearing, speed, leg, turn_ahead, dt):
        severity = min(1.0, max(turn_ahead, abs(bearing)) / 90)
        cruise = vehicle.max_speed * self.speed_scale * self.cruise_fraction
        corner_speed = max(self.min_corner_speed, cruise * (1 - self.corner_slowdown * severity))
        if leg < self.short_leg and severity > 0.35:
            corner_speed = min(corner_speed, max(self.min_corner_speed, cruise * self.short_leg_speed))

        throttle = brake = 0.0
        if speed > corner_speed + self.brake_margin:
            brake = min(1.0, (speed - corner_speed) / self.brake_range)
        elif speed <= corner_speed:
            throttle = max(0.35, 1 - 0.55 * severity)

        want_steer = self.lock(bearing, speed)
        if vehicle.drifting:  # catch the slide, don't tighten it
            want_steer *= 0.6
            throttle, brake = min(throttle, 0.3), 0.0
        self.ease_wheel(want_steer, dt)
        vehicle.drive(throttle=throttle, steer=self.steer, brake=brake)

    def lock(self, bearing, speed):
        authority = max(self.min_lock, 1 - abs(speed) / self.lock_fade_speed)
        return clamp(bearing / self.full_lock_angle, -1, 1) * authority

    def ease_wheel(self, want, dt):
        self.steer += (want - self.steer) * min(1.0, dt * self.steer_rate)

    def is_stuck(self, speed, dt):
        """Slow for too long without gaining speed, once the start is behind it."""
        if self.racing_for < self.launch_grace or speed >= self.stuck_speed:
            self.slow_for = self.slow_peak = 0.0
            return False
        if speed >= self.slow_peak + self.progress_step:
            self.slow_for, self.slow_peak = 0.0, speed
            return False
        self.slow_for += dt
        if self.slow_for < self.stuck_after:
            return False
        self.slow_for = self.slow_peak = 0.0
        return True

    def back_out(self, vehicle, speed, dt):
        self.reversing = max(0.0, self.reversing - dt)
        if self.reversing == 0:
            self.recovering = self.recover_for
        if speed < -self.reverse_max_speed:
            vehicle.drive(brake=1)
        else:
            vehicle.drive(throttle=-self.reverse_throttle, steer=-self.steer)

    def pull_away(self, vehicle, bearing, speed, dt):
        """Stop rolling backwards first, then drive forward with the stuck check off."""
        if speed > self.free_speed:
            self.back_outs = 0
        self.recovering = 0.0 if speed > self.stuck_speed else max(0.0, self.recovering - dt)
        if speed < -self.stuck_speed:
            vehicle.drive(brake=1)
            return
        self.ease_wheel(self.lock(bearing, speed), dt)
        vehicle.drive(throttle=1, steer=self.steer)
