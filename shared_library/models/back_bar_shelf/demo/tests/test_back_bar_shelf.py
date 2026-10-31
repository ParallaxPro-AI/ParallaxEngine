from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("back_bar_shelf: the prefab spawns and its model's controls work")
async def test_back_bar_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.back_bar_shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_1", 50.0)
    assert abs(model.joint("door_1") - 50.0) < 1e-3
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    assert model.socket_position("counter_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
