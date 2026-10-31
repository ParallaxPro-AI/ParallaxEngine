from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("barrier_water_filled: the prefab spawns and its model's controls work")
async def test_barrier_water_filled(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.barrier_water_filled, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("colour", "white")
    assert model.option("colour") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
