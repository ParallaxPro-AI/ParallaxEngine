from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mixing_console_live: the prefab spawns and its model's controls work")
async def test_mixing_console_live(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mixing_console_live, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fader_0", 0.055)
    assert abs(model.joint("fader_0") - 0.055) < 1e-3
    model.set_option("cheeks", "oak")
    assert model.option("cheeks") == "oak"
    assert model.socket_position("engineer").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
