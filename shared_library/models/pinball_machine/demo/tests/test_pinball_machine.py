from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pinball_machine: the prefab spawns and its model's controls work")
async def test_pinball_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pinball_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flipper_l", 27.5)
    assert abs(model.joint("flipper_l") - 27.5) < 1e-3
    model.set_option("cabinet", "red")
    assert model.option("cabinet") == "red"
    assert model.socket_position("player").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
