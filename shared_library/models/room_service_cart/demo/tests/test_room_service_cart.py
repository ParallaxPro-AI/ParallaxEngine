from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("room_service_cart: the prefab spawns and its model's controls work")
async def test_room_service_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.room_service_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_back", 45.0)
    assert abs(model.joint("leaf_back") - 45.0) < 1e-3
    model.set_option("wood", "ebony")
    assert model.option("wood") == "ebony"
    assert model.socket_position("table_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
