from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("motel: the prefab spawns and its model's controls work")
async def test_motel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.motel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("facade_colour", "mint")
    assert model.option("facade_colour") == "mint"
    assert model.socket_position("socket_office_desk").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
