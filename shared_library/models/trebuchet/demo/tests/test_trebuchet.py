from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("trebuchet: the prefab spawns and its model's controls work")
async def test_trebuchet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.trebuchet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm", 75.0)
    assert abs(model.joint("arm") - 75.0) < 1e-3
    model.set_option("timber", "oak")
    assert model.option("timber") == "oak"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
