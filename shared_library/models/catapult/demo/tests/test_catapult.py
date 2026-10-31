from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("catapult: the prefab spawns and its model's controls work")
async def test_catapult(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.catapult, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm", 48.0)
    assert abs(model.joint("arm") - 48.0) < 1e-3
    model.set_option("type", "trebuchet")
    assert model.option("type") == "trebuchet"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
