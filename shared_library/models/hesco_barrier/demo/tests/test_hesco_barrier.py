from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hesco_barrier: the prefab spawns and its model's controls work")
async def test_hesco_barrier(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hesco_barrier, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("liner", "olive")
    assert model.option("liner") == "olive"
    assert model.socket_position("end_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
