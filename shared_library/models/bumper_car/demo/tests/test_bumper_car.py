from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bumper_car: the prefab spawns and its model's controls work")
async def test_bumper_car(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bumper_car, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
