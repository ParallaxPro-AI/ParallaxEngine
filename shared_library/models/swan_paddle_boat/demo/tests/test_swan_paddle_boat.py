from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("swan_paddle_boat: the prefab spawns and its model's controls work")
async def test_swan_paddle_boat(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.swan_paddle_boat, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tiller", 0.0)
    assert abs(model.joint("tiller") - 0.0) < 1e-3
    model.set_option("plumage", "black")
    assert model.option("plumage") == "black"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
