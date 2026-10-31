from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("switch_block_colored: the prefab spawns and its model's controls work")
async def test_switch_block_colored(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.switch_block_colored, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("button", 0.03)
    assert abs(model.joint("button") - 0.03) < 1e-3
    model.set_option("color", "blue")
    assert model.option("color") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
