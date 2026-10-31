from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bloody_operating_tray: the prefab spawns and its model's controls work")
async def test_bloody_operating_tray(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bloody_operating_tray, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("riser", 0.125)
    assert abs(model.joint("riser") - 0.125) < 1e-3
    model.set_option("state", "clean")
    assert model.option("state") == "clean"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
