from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("security_monitor_wall: the prefab spawns and its model's controls work")
async def test_security_monitor_wall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.security_monitor_wall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("joystick", 0.0)
    assert abs(model.joint("joystick") - 0.0) < 1e-3
    model.set_option("screens", "green")
    assert model.option("screens") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
