from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scooter: the prefab spawns and its model's controls work")
async def test_scooter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scooter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("type", "kick")
    assert model.option("type") == "kick"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
