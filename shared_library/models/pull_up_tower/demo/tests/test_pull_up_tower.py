from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pull_up_tower: the prefab spawns and its model's controls work")
async def test_pull_up_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pull_up_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("vkr_carriage", 0.0)
    assert abs(model.joint("vkr_carriage") - 0.0) < 1e-3
    model.set_option("frame", "red")
    assert model.option("frame") == "red"
    assert model.socket_position("hang_bar").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
