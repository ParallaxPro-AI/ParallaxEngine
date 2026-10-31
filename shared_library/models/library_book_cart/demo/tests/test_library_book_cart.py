from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("library_book_cart: the prefab spawns and its model's controls work")
async def test_library_book_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.library_book_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("ends", "blue")
    assert model.option("ends") == "blue"
    assert model.socket_position("top_shelf_f").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
