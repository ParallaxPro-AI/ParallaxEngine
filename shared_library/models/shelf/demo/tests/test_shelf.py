from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shelf: the prefab spawns and its model's controls work")
async def test_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cup_door_l", 55.0)
    assert abs(model.joint("cup_door_l") - 55.0) < 1e-3
    model.set_option("finish", "aged")
    assert model.option("finish") == "aged"
    assert model.socket_position("socket_shelf_top").distance_to(thing.transform.position) < 3.06
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
