from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("elevator_platform: the prefab spawns and its model's controls work")
async def test_elevator_platform(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.elevator_platform, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("car", 2.0)
    assert abs(model.joint("car") - 2.0) < 1e-3
    model.set_option("paint", "grey")
    assert model.option("paint") == "grey"
    assert model.socket_position("call_panel").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
