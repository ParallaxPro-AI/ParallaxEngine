from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("game_console: the prefab spawns and its model's controls work")
async def test_game_console(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.game_console, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("power_button", 0.0013)
    assert abs(model.joint("power_button") - 0.0013) < 1e-3
    model.set_option("shell", "black")
    assert model.option("shell") == "black"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
