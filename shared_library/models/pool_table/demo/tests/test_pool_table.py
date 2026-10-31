from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pool_table: the prefab spawns and its model's controls work")
async def test_pool_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pool_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cues", 16.0)
    assert abs(model.joint("cues") - 16.0) < 1e-3
    assert model.socket_position("socket_rack_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
