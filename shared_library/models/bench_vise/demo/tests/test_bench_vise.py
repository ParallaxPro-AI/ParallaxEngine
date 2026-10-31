from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bench_vise: the prefab spawns and its model's controls work")
async def test_bench_vise(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bench_vise, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("swivel", 0.0)
    assert abs(model.joint("swivel") - 0.0) < 1e-3
    model.set_option("paint", "grey")
    assert model.option("paint") == "grey"
    assert model.socket_position("workpiece").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
