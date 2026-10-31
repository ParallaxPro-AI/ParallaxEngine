from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("launch_rocket: the prefab spawns and its model's controls work")
async def test_launch_rocket(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.launch_rocket, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("engine_centre", 0.0)
    assert abs(model.joint("engine_centre") - 0.0) < 1e-3
    model.set_option("livery", "red")
    assert model.option("livery") == "red"
    assert model.socket_position("socket_payload").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
