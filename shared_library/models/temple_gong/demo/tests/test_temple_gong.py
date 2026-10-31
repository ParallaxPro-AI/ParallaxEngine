from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("temple_gong: the prefab spawns and its model's controls work")
async def test_temple_gong(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.temple_gong, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("swing", 0.0)
    assert abs(model.joint("swing") - 0.0) < 1e-3
    assert model.socket_position("mallet_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
