from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("game_controller: the prefab spawns and its model's controls work")
async def test_game_controller(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.game_controller, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stick_l", 0.0)
    assert abs(model.joint("stick_l") - 0.0) < 1e-3
    model.set_option("colour", "white")
    assert model.option("colour") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
