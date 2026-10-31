from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("barn: the prefab spawns and its model's controls work")
async def test_barn(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.barn, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_front_l", 1.0)
    assert abs(model.joint("door_front_l") - 1.0) < 1e-3
    model.set_option("siding_colour", "weathered_grey")
    assert model.option("siding_colour") == "weathered_grey"
    assert model.socket_position("socket_door_outside").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
