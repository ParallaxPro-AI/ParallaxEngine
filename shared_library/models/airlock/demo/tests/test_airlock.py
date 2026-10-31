from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("airlock: the prefab spawns and its model's controls work")
async def test_airlock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.airlock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_left", 0.25)
    assert abs(model.joint("leaf_left") - 0.25) < 1e-3
    assert model.socket_position("socket_threshold").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
