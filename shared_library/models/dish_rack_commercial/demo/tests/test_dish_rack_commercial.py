from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dish_rack_commercial: the prefab spawns and its model's controls work")
async def test_dish_rack_commercial(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dish_rack_commercial, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("load", "empty")
    assert model.option("load") == "empty"
    assert model.socket_position("shelf_plates").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
