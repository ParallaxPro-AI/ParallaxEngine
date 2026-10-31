from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pharmacy_shelf: the prefab spawns and its model's controls work")
async def test_pharmacy_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pharmacy_shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("accent", "white")
    assert model.option("accent") == "white"
    assert model.socket_position("socket_shelf_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
