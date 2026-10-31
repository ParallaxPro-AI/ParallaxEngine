from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mini_golf_obstacle: the prefab spawns and its model's controls work")
async def test_mini_golf_obstacle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mini_golf_obstacle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flagstick", 0.15)
    assert abs(model.joint("flagstick") - 0.15) < 1e-3
    model.set_option("carpet", "blue")
    assert model.option("carpet") == "blue"
    assert model.socket_position("socket_tee").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
