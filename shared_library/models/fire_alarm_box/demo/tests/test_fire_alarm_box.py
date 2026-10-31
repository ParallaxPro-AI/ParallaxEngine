from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fire_alarm_box: the prefab spawns and its model's controls work")
async def test_fire_alarm_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fire_alarm_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pull_hook", 30.0)
    assert abs(model.joint("pull_hook") - 30.0) < 1e-3
    model.set_option("paint", "bright_red")
    assert model.option("paint") == "bright_red"
    assert model.socket_position("socket_hook").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
