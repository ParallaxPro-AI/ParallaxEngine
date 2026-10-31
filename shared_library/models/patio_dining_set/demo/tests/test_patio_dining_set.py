from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("patio_dining_set: the prefab spawns and its model's controls work")
async def test_patio_dining_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.patio_dining_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("parasol", "none")
    assert model.option("parasol") == "none"
    assert model.socket_position("socket_table").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
