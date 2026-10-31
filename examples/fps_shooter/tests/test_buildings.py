from parallax import Vec2, Vec3
from parallax.characters import Character
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from project import Scenes

from game.actions import FpsControls
from game.components import Player
from game.ui import TitleScreen

# flat_a (the template's first block of flats; the layout is the template's mirrored across
# z), world coordinates: the street door on its east face at x -7.75 (z -15 to -13), the
# ground flight up its west side (x -16 to -14.5, z -17 to -12, climbing -z), the upper
# flight across its north end (z -18 to -16.5, x -14.5 to -9.5, climbing +x) onto the roof
# deck at 7.05 m behind the 0.75 m parapet. (shop_a has the same plan, but the template
# stands a streetlight square in front of its street door.)
STREET = Vec3(-5.5, 0, -14)
ROUTE = [Vec3(-6.5, 0, -14), Vec3(-10, 0, -14), Vec3(-13.5, 0, -11.6), Vec3(-15.25, 0, -11.6), Vec3(-15.25, 0, -17.4),
         Vec3(-15.1, 0, -17.25), Vec3(-8.3, 0, -17.25)]
ROOF = 7.05


def you(game: GameHarness):
    return game.world.query(tagged=Player).single()


async def walk(game: GameHarness, target: Vec3, timeout: float = 6) -> None:
    """Walk the player to a point (x, z) with the move stick held, steering by the camera."""
    camera = game.ctx.camera.main
    player = you(game)
    held = Vec2(0, 0)
    for _ in range(int(timeout * 60)):
        here = player.transform.position
        to = Vec3(target.x - here.x, 0, target.z - here.z)
        if to.length() < 0.3:
            return
        d = to.normalized()
        stick = Vec2(d.dot(camera.relative(Vec2(1, 0))), d.dot(camera.relative(Vec2(0, 1))))
        # Re-aim only when the heading drifts: pushing the stick anew restarts the walk.
        if stick.dot(held) < 0.98:
            held = stick
            await game.move(FpsControls.move, stick)
        health = player.get(Health)
        if health.current < health.max / 2:
            health.current = health.max  # the bots keep shooting
        await game.advance(frames=1)
    raise AssertionError(f"didn't reach {target} (at {player.transform.position})")


@playtest("through the flats' door, up both flights and out onto the roof behind its parapet")
async def onto_the_roof(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    you(game).get(Character).teleport(STREET + Vec3(0, 0, -2))
    await game.advance(frames=2)
    for point in ROUTE[:2]:
        await walk(game, point)
    assert you(game).transform.position.x < -8, "in through the street door"
    for point in ROUTE[2:5]:
        await walk(game, point)
    assert you(game).transform.position.y > 3.3, "the ground flight lands on the upper floor"
    for point in ROUTE[5:]:
        await walk(game, point)
    await game.release(FpsControls.move)
    await game.advance(frames=10)
    at = you(game).transform.position
    assert abs(at.y - ROOF) < 0.2, f"standing on the roof deck, at {at}"
    assert -16.5 < at.x < -7.5 and -19 < at.z < -9, "inside the parapet"


@playtest("bots can path from the street into the flats, upstairs and onto the roof")
async def bot_routes(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    upstairs = game.ctx.nav.path(STREET, Vec3(-11, 3.45, -12))
    assert len(upstairs) > 2 and abs(upstairs[-1].y - 3.45) < 0.2, "the upper floor is reachable"
    roof = game.ctx.nav.path(STREET, Vec3(-12, ROOF, -12))
    assert len(roof) > 2 and abs(roof[-1].y - ROOF) < 0.2, "and the roof"
    across = game.ctx.nav.path(Vec3(0, 0, -40), Vec3(0, 0, 40))
    assert len(across) > 1, "the street still runs end to end"
