from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("guard_booth: the prefab spawns and its model's controls work")
async def test_guard_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.guard_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("camera_pan", 0.0)
    assert abs(model.joint("camera_pan") - 0.0) < 1e-3
    model.set_option("wall_colour", "grey")
    assert model.option("wall_colour") == "grey"
    assert model.socket_position("socket_guard").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
