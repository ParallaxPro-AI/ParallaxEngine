from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ice_cream_tub_display: the prefab spawns and its model's controls work")
async def test_ice_cream_tub_display(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ice_cream_tub_display, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 0.265)
    assert abs(model.joint("door_l") - 0.265) < 1e-3
    model.set_option("body", "pink")
    assert model.option("body") == "pink"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
