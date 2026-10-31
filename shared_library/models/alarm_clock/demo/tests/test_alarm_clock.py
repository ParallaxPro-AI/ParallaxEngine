from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("alarm_clock: the prefab spawns and its model's controls work")
async def test_alarm_clock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.alarm_clock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hammer", 0.0)
    assert abs(model.joint("hammer") - 0.0) < 1e-3
    model.set_option("colour", "black")
    assert model.option("colour") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
