from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shoji_screen: the prefab spawns and its model's controls work")
async def test_shoji_screen(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shoji_screen, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("panel_l", 0.44)
    assert abs(model.joint("panel_l") - 0.44) < 1e-3
    model.set_option("wood", "stained")
    assert model.option("wood") == "stained"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
