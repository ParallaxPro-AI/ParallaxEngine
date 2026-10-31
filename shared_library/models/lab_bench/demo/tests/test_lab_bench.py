from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lab_bench: the prefab spawns and its model's controls work")
async def test_lab_bench(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lab_bench, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sink_cover", 40.0)
    assert abs(model.joint("sink_cover") - 40.0) < 1e-3
    assert model.socket_position("socket_basin").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
