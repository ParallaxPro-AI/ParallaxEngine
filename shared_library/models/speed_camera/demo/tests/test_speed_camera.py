from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("speed_camera: the prefab spawns and its model's controls work")
async def test_speed_camera(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.speed_camera, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("housing", 0.0)
    assert abs(model.joint("housing") - 0.0) < 1e-3
    model.set_option("housing", "grey")
    assert model.option("housing") == "grey"
    assert model.socket_position("socket_flash").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
