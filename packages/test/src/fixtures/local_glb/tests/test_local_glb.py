from parallax import Model
from parallax.test import playtest
from project import Placed


@playtest("a project's own .glb model loads in a playtest")
async def test_local_glb(game):
    # A model the playtest can't read is a PP3804 error at start; reading it is the test.
    await game.start()
    await game.advance(frames=3)
    assert game.world.placed(Placed.crate).has(Model)
