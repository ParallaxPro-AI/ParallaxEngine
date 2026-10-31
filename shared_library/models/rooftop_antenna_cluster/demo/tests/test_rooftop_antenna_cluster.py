from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rooftop_antenna_cluster: the prefab spawns and its model's controls work")
async def test_rooftop_antenna_cluster(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rooftop_antenna_cluster, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("dish", 0.0)
    assert abs(model.joint("dish") - 0.0) < 1e-3
    assert model.socket_position("socket_technician").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
