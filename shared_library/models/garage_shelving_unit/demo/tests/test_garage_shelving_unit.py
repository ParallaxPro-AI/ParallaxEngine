from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("garage_shelving_unit: the prefab spawns and its model's controls work")
async def test_garage_shelving_unit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.garage_shelving_unit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame", "blue")
    assert model.option("frame") == "blue"
    assert model.socket_position("socket_shelf_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
