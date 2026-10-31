from parallax import System, system
from project import Text

from game.audio import Sounds, play
from game.components import PlayerCar, Racer, TrackScene
from game.events import RaceFinished
from game.lib.time_trial import FinishReached
from game.formatting import format_time
from game.resources import Race, RacePhase
from game.rules import is_racing, racing_line
from game.track import flat_distance, gate, laps_done


@system("lap_counting", scenes=[TrackScene], when=is_racing)
class LapCounting(System):
    """The race rules: gates in order, laps and lap times, finishing places, and the
    wrong-way clock. The race ends the moment the player crosses the line."""

    def fixed_update(self, ctx, dt):
        line = racing_line(ctx)
        for car, racer in ctx.world.query(Racer).where(lambda car, racer: not racer.finish_place):
            here, target = car.transform.position, gate(line, racer.gates_passed)
            facing = car.transform.forward.flat().normalized().dot((target - here).flat().normalized())
            racer.wrong_way_for = racer.wrong_way_for + dt if facing < -0.5 else 0.0
            if flat_distance(here, target) > line.gate_radius:
                continue
            racer.gates_passed += 1
            lap_done = racer.gates_passed % len(line.points) == 0
            if car.has(PlayerCar):
                sounds = ctx.config(Sounds)
                play(ctx, sounds.lap if lap_done else sounds.checkpoint)
            if lap_done:
                self.complete_lap(ctx, car, racer, laps_done(line, racer))

    def complete_lap(self, ctx, car, racer, lap):
        race = ctx.get(Race)
        lap_time = ctx.time.now - racer.lap_started_at
        racer.lap_started_at = ctx.time.now
        racer.best_lap = min(racer.best_lap, lap_time) if racer.best_lap else lap_time

        if lap < race.laps:
            if car.has(PlayerCar):
                ctx.ui.toast(ctx.text(Text.lap_time_toast, lap=lap, time=format_time(lap_time)))
                if lap == race.laps - 1:
                    ctx.ui.announce(Text.final_lap)
            return

        racer.finish_place = 1 + ctx.world.query(Racer).where(lambda _, other: other.finish_place > 0).count()
        racer.finish_time = ctx.time.now - race.started_at
        if car.has(PlayerCar):
            race.phase = RacePhase.FINISHED
            ctx.emit(FinishReached())  # time_trial keeps the best race and ghost_racer its take
            ctx.emit(RaceFinished())
