from parallax import Vec3
from parallax.physics import Rigidbody
from parallax.test import playtest
from parallax.vehicles import Vehicle
from project import Content, Scenes

from game.actions import DriveControls
from game.components import GhostCar, Nitro, PlayerCar, Racer
from game.config import RaceRules
from game.lib.ghost_racer import GhostRecords
from game.resources import Career, Race, RacePhase, RacePlan, RaceResult, Season
from game.rules import is_racing, racing_line
from game.track import line_offset
from game.ui import CarSelect, MapSelect, PauseMenu, RaceSettings, ResultsPanel, TitleScreen


def player(game):
    return game.world.query(Racer, tagged=PlayerCar).single()


async def lights_out(game):
    await game.advance_until(lambda: is_racing(game.ctx), timeout=5)


async def cross_the_line(game):
    """Put the player one gate short of the flag on the last lap, on the line."""
    line = racing_line(game.ctx)
    car, racer = player(game)
    racer.gates_passed = game.get(Race).laps * len(line.points) - 1
    car.get(Rigidbody).teleport(line.points[-1] + Vec3(0, 1.4, 0))
    await game.advance(frames=3)


async def start_from_garage(game, **options):
    """The template's screen flow: car select -> map select -> race settings -> race."""
    await game.click(CarSelect, "next")
    await game.advance(frames=2)
    if "track" in options:
        await game.click(MapSelect, "pick_track", track=options.pop("track"))
    await game.click(MapSelect, "next")
    await game.advance(frames=2)
    for row, value in options.items():
        await game.click(RaceSettings, "set_option", row=row, value=value)
    await game.click(RaceSettings, "start")


async def championship_round(game):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "championship")
    await game.advance(frames=2)
    await start_from_garage(game)
    await game.advance(frames=2)


@playtest("quick race: the garage's picks decide the track, laps, field and weather")
async def test_quick_race_settings(game):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "quick_race")
    await game.advance(frames=2)
    assert game.panel_state(CarSelect)["no_season"]
    await start_from_garage(game, track=Content.track.canyon_carver, laps="1", opponents="1", weather="rain")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.canyon_carver)
    race = game.get(Race)
    assert race.round is None and race.laps == 1
    assert game.world.query(Racer).count() == 2
    assert game.ctx.weather.preset == "rain"


@playtest("rain wets the road: the weather plugin's friction falls below dry")
async def test_rain_cuts_grip(game):
    await game.start(scene=Scenes.garage)
    game.get(RacePlan).weather = Content.weather.rain
    await start_from_garage(game)
    await game.advance(seconds=8)
    assert game.ctx.weather.friction < 0.95


@playtest("the championship's Race button starts the current round on its track")
async def test_garage_to_track(game):
    await championship_round(game)
    assert game.ctx.scenes.current_is(Scenes.terrain_sprint)
    assert game.world.query(Racer).count() == 4
    race = game.get(Race)
    assert race.phase is RacePhase.COUNTDOWN
    assert race.round == Content.round.opening_sprint and race.laps == 2


@playtest("the grid holds through the countdown, even with the throttle down")
async def test_grid_holds(game):
    await game.start(scene=Scenes.terrain_sprint)
    await game.set_axis(DriveControls.throttle, 1, seconds=2)
    car, _ = player(game)
    assert abs(car.get(Vehicle).speed) < 0.5


@playtest("after the lights, full throttle reaches the first gate and the rivals get away")
async def test_everyone_races(game):
    await game.start(scene=Scenes.terrain_sprint)
    await lights_out(game)
    await game.set_axis(DriveControls.throttle, 1, seconds=8)
    assert all(racer.gates_passed >= 1 for _, racer in game.world.query(Racer))


@playtest("the pause key opens the pause menu and closes it again")
async def test_pause_toggles(game):
    await game.start(scene=Scenes.terrain_sprint)
    await game.press(DriveControls.pause)
    assert game.is_open(PauseMenu)
    await game.press(DriveControls.pause)
    assert not game.is_open(PauseMenu)


@playtest("a championship finish scores the round, and Next round runs the next track")
async def test_finish_scores_round(game):
    await championship_round(game)
    await lights_out(game)
    credits = game.get(Career).credits
    await cross_the_line(game)
    assert game.is_open(ResultsPanel)
    assert game.get(Season).round == 1
    assert game.get(Season).points["player"] > 0
    assert game.get(Career).credits > credits
    assert game.panel_state(ResultsPanel)["has_next_round"]
    await game.click(ResultsPanel, "next_round")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.canyon_carver)
    assert game.get(Race).round == Content.round.canyon_rain


@playtest("a quick race pays the purse but leaves the championship alone; Retry runs it again")
async def test_quick_race_finish(game):
    await game.start(scene=Scenes.terrain_sprint)
    await lights_out(game)
    credits = game.get(Career).credits
    await cross_the_line(game)
    assert game.is_open(ResultsPanel)
    assert game.get(Career).credits > credits
    assert game.get(Season).round == 0 and not game.get(Season).points
    assert not game.get(RaceResult).has_next_round
    await game.click(ResultsPanel, "retry")
    await game.advance(frames=2)
    assert game.get(Race).phase is RacePhase.COUNTDOWN


@playtest("the last round closes the season: the leader takes the title and the prize")
async def test_season_ends(game):
    await game.start(scene=Scenes.garage)
    game.get(Season).round = 3
    game.get(RacePlan).championship = True
    await start_from_garage(game)
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.canyon_carver)
    await lights_out(game)
    await cross_the_line(game)
    result = game.get(RaceResult)
    assert result.season_over and not result.has_next_round
    assert result.champion == result.standings[0].is_player
    assert game.get(Season).round == 0


@playtest("the pause menu and its key don't exist in the garage")
async def test_no_pause_in_garage(game):
    await game.start(scene=Scenes.garage)
    await game.press(DriveControls.pause)
    assert not game.is_open(PauseMenu)


@playtest("bought slicks stack on the car's own grip as a modifier")
async def test_parts_modify_the_car(game):
    await game.start(scene=Scenes.garage)
    game.get(Career).part_tiers["tires"] = 2
    await start_from_garage(game)
    await game.advance(frames=2)
    car, _ = player(game)
    assert abs(car.get(Vehicle).grip - 1.0 * 1.18) < 1e-6  # Bolt's prefab grip × Slicks; weather grip is the plugin's


@playtest("the best race is a ghost on the next attempt at the same laps, and only at those laps")
async def test_ghost_car(game):
    await game.start(scene=Scenes.terrain_sprint)
    laps = game.get(Race).laps
    await lights_out(game)
    await game.set_axis(DriveControls.throttle, 1, seconds=2)
    car, _ = player(game)
    at_two = game.world.query(Nitro).single()[0].transform.position  # the recorder rides on the driver, in the seat
    await cross_the_line(game)
    best = game.get(GhostRecords).best[f"terrain_sprint:{laps}"]
    assert best.samples and best.seconds > 1.9, (len(best.samples), best.seconds)
    assert game.panel_state(ResultsPanel)["ghost_beaten"] and not game.panel_state(ResultsPanel)["had_ghost"]

    await game.click(ResultsPanel, "retry")
    await game.advance(frames=2)
    assert game.get(Race).ghost_best == best.seconds
    ghost = game.world.query(tagged=GhostCar).single()
    assert not ghost.visible  # nothing to show on the grid
    await lights_out(game)
    await game.advance(seconds=2)
    assert ghost.visible and (ghost.transform.position - at_two).flat().length() < 3
    assert abs(ghost.transform.position.y - at_two.y) < 0.3, (ghost.transform.position.y, at_two.y)

    game.get(RacePlan).laps = 1 if laps != 1 else 2
    game.ctx.scenes.reload()
    await game.advance(frames=2)
    await lights_out(game)
    await game.advance(seconds=1)
    assert game.get(Race).ghost_best < 0
    assert not game.world.query(tagged=GhostCar).single().visible


@playtest("off the racing line is off the track: dust and the verge rumble key on it")
async def test_off_track(game):
    await game.start(scene=Scenes.terrain_sprint)
    await lights_out(game)
    line = racing_line(game.ctx)
    car, racer = player(game)
    assert line_offset(line, car.transform.position, racer) < game.config(RaceRules).road_half_width
    side = (line.points[1] - line.points[0]).flat().normalized().cross(Vec3.UP)
    assert line_offset(line, line.points[0] + side * 20, racer) > 19
    mid = (line.points[3] + line.points[4]) * 0.5
    assert game.ctx.terrain.surface_at(mid) == "road"  # the circuit is painted and graded on the terrain
    verge = mid + side * 30
    assert game.ctx.terrain.surface_at(verge) != "road"
    await game.set_axis(DriveControls.throttle, 1, seconds=1.5)
    await game.hold(DriveControls.drift, seconds=1)  # sliding: smoke, no errors


@playtest("the flyby plays over the countdown and hands the camera back to the chase at GO")
async def test_race_intro(game):
    from parallax.cinematics import CinematicStarted
    await game.start(scene=Scenes.terrain_sprint)
    await game.advance(frames=2)
    assert game.ctx.cinematics.playing
    assert game.emitted(CinematicStarted)[0].cinematic == Content.cinematic.race_intro_sprint
    await lights_out(game)
    await game.advance(frames=3)
    car, _ = player(game)
    assert not game.ctx.cinematics.playing
    assert game.ctx.camera.main.follow == car


@playtest("the tachometer reads the real drivetrain: revs climb and the box shifts up")
async def test_tachometer(game):
    from game.ui import Hud
    await game.start(scene=Scenes.terrain_sprint)
    await lights_out(game)
    assert game.panel_state(Hud)["gear"] == "1"
    await game.set_axis(DriveControls.throttle, 1, seconds=2.5)
    hud = game.panel_state(Hud)
    rpm = int(hud["rpm_text"].split()[0].replace(",", ""))
    assert hud["gear"] != "1" and rpm > 2000 and hud["tach_sweep"] and any(seg["on"] for seg in hud["rpm_segs"])


@playtest("the rivals keep going: a rolled or beached rival is put back on the line")
async def test_rivals_keep_going(game):
    await game.start(scene=Scenes.terrain_sprint)
    await lights_out(game)
    await game.advance(seconds=40)
    progress = [racer.gates_passed for _, racer in game.world.query(Racer, without=[PlayerCar])]
    assert len(progress) == 3 and min(progress) >= 9, progress
