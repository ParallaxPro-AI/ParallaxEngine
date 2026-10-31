from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chute_racer: the prefab spawns and its model's controls work")
async def test_chute_racer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chute_racer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer_l", 0.0)
    assert abs(model.joint("steer_l") - 0.0) < 1e-3
    await game.advance(seconds=1)
