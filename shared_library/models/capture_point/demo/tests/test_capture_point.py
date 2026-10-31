from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("capture_point: the prefab spawns and its model's controls work")
async def test_capture_point(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.capture_point, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flag_raise", 1.575)
    assert abs(model.joint("flag_raise") - 1.575) < 1e-3
    model.set_option("team", "blue")
    assert model.option("team") == "blue"
    assert model.socket_position("socket_zone").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
