from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("greenhouse_lean_to: the prefab spawns and its model's controls work")
async def test_greenhouse_lean_to(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.greenhouse_lean_to, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("vent", 16.0)
    assert abs(model.joint("vent") - 16.0) < 1e-3
    model.set_option("frame_finish", "green")
    assert model.option("frame_finish") == "green"
    assert model.socket_position("socket_door_outside").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
