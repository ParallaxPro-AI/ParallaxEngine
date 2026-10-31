from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bus: the prefab spawns and its model's controls work")
async def test_bus(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bus, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_front", 44.0)
    assert abs(model.joint("door_front") - 44.0) < 1e-3
    model.set_option("type", "school")
    assert model.option("type") == "school"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 20.67
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
