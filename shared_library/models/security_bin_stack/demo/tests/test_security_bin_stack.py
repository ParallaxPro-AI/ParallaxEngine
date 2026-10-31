from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("security_bin_stack: the prefab spawns and its model's controls work")
async def test_security_bin_stack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.security_bin_stack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("tray_colour", "blue")
    assert model.option("tray_colour") == "blue"
    assert model.socket_position("tray_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
