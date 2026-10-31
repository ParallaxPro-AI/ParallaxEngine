from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("semi_tractor: the prefab spawns and its model's controls work")
async def test_semi_tractor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.semi_tractor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_tilt", 26.0)
    assert abs(model.joint("cab_tilt") - 26.0) < 1e-3
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
