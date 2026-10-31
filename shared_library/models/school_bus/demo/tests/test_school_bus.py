from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("school_bus: the prefab spawns and its model's controls work")
async def test_school_bus(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.school_bus, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("crossing_arm", 42.5)
    assert abs(model.joint("crossing_arm") - 42.5) < 1e-3
    model.set_option("paint", "yellow")
    assert model.option("paint") == "yellow"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
