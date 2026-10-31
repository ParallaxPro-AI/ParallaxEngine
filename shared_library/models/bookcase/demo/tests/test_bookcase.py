from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bookcase: the prefab spawns and its model's controls work")
async def test_bookcase(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bookcase, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("height", "tall")
    assert model.option("height") == "tall"
    assert model.socket_position("socket_shelf_low").distance_to(thing.transform.position) < 2.99
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
