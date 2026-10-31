from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cable_crossover: the prefab spawns and its model's controls work")
async def test_cable_crossover(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cable_crossover, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stack_l", 0.275)
    assert abs(model.joint("stack_l") - 0.275) < 1e-3
    model.set_option("frame", "red")
    assert model.option("frame") == "red"
    assert model.socket_position("socket_handle_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
