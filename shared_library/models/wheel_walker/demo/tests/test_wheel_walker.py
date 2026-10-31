from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wheel_walker: the prefab spawns and its model's controls work")
async def test_wheel_walker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wheel_walker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fold_l", 42.0)
    assert abs(model.joint("fold_l") - 42.0) < 1e-3
    model.set_option("frame", "bronze")
    assert model.option("frame") == "bronze"
    assert model.socket_position("grip_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
