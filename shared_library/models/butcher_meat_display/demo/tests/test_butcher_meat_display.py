from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("butcher_meat_display: the prefab spawns and its model's controls work")
async def test_butcher_meat_display(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.butcher_meat_display, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 50.0)
    assert abs(model.joint("door_l") - 50.0) < 1e-3
    model.set_option("body", "black")
    assert model.option("body") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
