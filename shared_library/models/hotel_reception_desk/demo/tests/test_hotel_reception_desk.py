from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hotel_reception_desk: the prefab spawns and its model's controls work")
async def test_hotel_reception_desk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hotel_reception_desk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_l1", 0.2)
    assert abs(model.joint("drawer_l1") - 0.2) < 1e-3
    model.set_option("wood", "ebony")
    assert model.option("wood") == "ebony"
    assert model.socket_position("visitor_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
