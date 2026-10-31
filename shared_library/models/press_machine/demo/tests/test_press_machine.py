from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("press_machine: the prefab spawns and its model's controls work")
async def test_press_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.press_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ram", 0.24)
    assert abs(model.joint("ram") - 0.24) < 1e-3
    assert model.socket_position("socket_die").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
