from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("smith_machine: the prefab spawns and its model's controls work")
async def test_smith_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.smith_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("safety_stops", 0.15)
    assert abs(model.joint("safety_stops") - 0.15) < 1e-3
    model.set_option("load", "light")
    assert model.option("load") == "light"
    assert model.socket_position("socket_bar").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
