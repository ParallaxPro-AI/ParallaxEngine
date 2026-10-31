from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("button_panel: the prefab spawns and its model's controls work")
async def test_button_panel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.button_panel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("button", 0.009)
    assert abs(model.joint("button") - 0.009) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
