from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("popup_canopy_tent: the prefab spawns and its model's controls work")
async def test_popup_canopy_tent(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.popup_canopy_tent, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("frame", 0.56)
    assert abs(model.joint("frame") - 0.56) < 1e-3
    model.set_option("canopy", "red")
    assert model.option("canopy") == "red"
    assert model.socket_position("socket_table").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
