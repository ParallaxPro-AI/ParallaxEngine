from parallax import Color, ContentRef, Entity, SceneLoaded, System, Vec3, on, system
from parallax.hud import MapIcon, Minimap
from parallax.vehicles import Drivetrain, Vehicle
from parallax.weather import LightningStruck
from project import Prefabs, Text

from game.audio import Sounds, play
from game.components import GhostCar, Nitro, PlayerCar, Racer, TrackScene
from game.config import RaceRules
from game.content import CarDef, PartDef
from game.lib.time_trial import TrialRecords, TrialRun, TrialStarted, trial_key
from game.resources import Career, Race, RacePhase
from game.rules import installed_tier, on_the_ground, racing_line, settle_terms
from game.track import grid_pose


@system("race_setup", scenes=[TrackScene])
class RaceSetup(System):
    """Builds the grid when a track scene loads, then counts the lights down.

    The race's terms (a championship round's, or the quick race's picks) decide the
    laps, the field, the weather and the hour; the rivals line up ahead and the player
    starts from the back in the car picked in the garage, tuned by the parts bought
    there. The weather plugin wets the road for every car — the road is the road. The
    countdown is a task of this scene-scoped system, so Restart cancels it."""

    @on(SceneLoaded)
    def build_grid(self, ctx, event):
        line = racing_line(ctx)
        career = ctx.get(Career)
        settle_terms(ctx)
        race = ctx.get(Race)
        race.phase = RacePhase.COUNTDOWN
        ctx.get(TrialRun).variant = str(race.laps)  # one ghost per track AND lap count
        race.ghost_best = ctx.get(TrialRecords).best.get(trial_key(ctx), -1)
        self.light_the_track(ctx, race)
        ctx.world.spawn(Prefabs.ghost_car, at=on_the_ground(ctx, line.points[0]), tags=[GhostCar])

        rivals = [car for car in ctx.content(CarDef) if car != career.car][:race.opponents]
        for slot, car in enumerate(rivals):
            self.place_rival(ctx, line, slot, car)
        player = self.place_car(ctx, line, len(rivals), career.car, tags=[PlayerCar])
        player.add(Minimap(range=140, rotate=True, route=list(line.points) + [line.points[0]]))
        player.get(MapIcon).color = Color.hex("#f97316")
        driver = ctx.world.spawn(Prefabs.player_driver, parent=player)  # drivers read their car as self.entity.parent
        self.install_parts(ctx, player, driver)
        player.get(Vehicle).enter(driver)
        ctx.camera.main.follow = player

        ctx.run(self.count_down)

    def light_the_track(self, ctx, race: Race):
        """The race's hour and weather, over the track scene's own environment."""
        ctx.environment.time_of_day = race.time_of_day.data.hour
        # Clear races keep the track's own haze and clouds; any other weather takes the sky over.
        if race.weather.data.preset != "clear":
            ctx.weather.set(race.weather.data.preset, seconds=0)

    @on(LightningStruck)
    def lightning_kick(self, ctx, event):
        """A strike kicks the camera, harder the closer and brighter it is."""
        ctx.camera.main.shake(0.16 + event.strength * 0.28, 0.28 + event.strength * 0.24)

    def place_car(self, ctx, line, slot, car: ContentRef[CarDef], *, tags=()):
        point, yaw = grid_pose(line, slot, ctx.config(RaceRules))
        return ctx.world.spawn(car.data.prefab, at=on_the_ground(ctx, point), rotation=Vec3(0, yaw, 0),
                               components=[Racer(car=car), MapIcon(icon="arrow", rotate=True)], tags=tags)

    def place_rival(self, ctx, line, slot, car):
        rival = self.place_car(ctx, line, slot, car)
        skill = ctx.get(Career).difficulty.data.ai_speed_scale
        rival.get(Vehicle).enter(ctx.world.spawn(Prefabs.ai_driver, parent=rival,
                                                  params={"ai_driver": {"speed_scale": skill}}))

    def install_parts(self, ctx, car: Entity, driver: Entity):
        """Bought parts are the real car: each tier stacks modifiers on the simulation
        (keyed by the part), over the prefab's own tuning and the weather's grip."""
        for part in ctx.content(PartDef):
            tier = installed_tier(ctx, part)
            car.modify(Drivetrain, "peak_torque", multiply=tier.torque, key=part.id)
            car.modify(Vehicle, "max_speed", multiply=tier.top_speed, key=part.id)
            car.modify(Vehicle, "grip", multiply=tier.grip, key=part.id)
            car.modify(Vehicle, "braking", multiply=tier.brake, key=part.id)  # PROPOSED: Vehicle.braking modifiable
            driver.modify(Nitro, "capacity", multiply=tier.nitro_capacity, key=part.id)
            driver.modify(Nitro, "gain_scale", multiply=tier.nitro_gain, key=part.id)

    async def count_down(self, ctx, task):
        step = ctx.config(RaceRules).countdown_step
        for number in (3, 2, 1):
            ctx.ui.announce(str(number), seconds=step)
            play(ctx, ctx.config(Sounds).countdown_beep)
            await task.seconds(step)
        race = ctx.get(Race)
        race.phase = RacePhase.RACING
        race.started_at = ctx.time.now
        for _, racer in ctx.world.query(Racer):
            racer.lap_started_at = ctx.time.now
        ctx.emit(TrialStarted())  # the ghost's clock: the best race replays from the lights
        ctx.ui.announce(Text.go)
        play(ctx, ctx.config(Sounds).race_go)
