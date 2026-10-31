from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_window_sash: the prefab spawns and its model's controls work")
async def test_house_window_sash(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_window_sash, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sash_upper", 0.21)
    assert abs(model.joint("sash_upper") - 0.21) < 1e-3
    model.set_option("panes", "one_over_one")
    assert model.option("panes") == "one_over_one"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
