from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("road_paver: the prefab spawns and its model's controls work")
async def test_road_paver(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.road_paver, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hopper_l", 31.0)
    assert abs(model.joint("hopper_l") - 31.0) < 1e-3
    model.set_option("paint", "orange")
    assert model.option("paint") == "orange"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
