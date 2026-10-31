from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coffee_machine: the prefab spawns and its model's controls work")
async def test_coffee_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coffee_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("portafilter", 20.0)
    assert abs(model.joint("portafilter") - 20.0) < 1e-3
    model.set_option("type", "drip")
    assert model.option("type") == "drip"
    assert model.socket_position("socket_cup").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
