from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("helicopter: the prefab spawns and its model's controls work")
async def test_helicopter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.helicopter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 36.0)
    assert abs(model.joint("door_l") - 36.0) < 1e-3
    model.set_option("config", "military")
    assert model.option("config") == "military"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
