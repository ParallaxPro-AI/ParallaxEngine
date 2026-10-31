from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("c4_charge: the prefab spawns and its model's controls work")
async def test_c4_charge(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.c4_charge, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("keypad_cover", 52.5)
    assert abs(model.joint("keypad_cover") - 52.5) < 1e-3
    model.set_option("wrap", "tan")
    assert model.option("wrap") == "tan"
    assert model.socket_position("socket_led").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
