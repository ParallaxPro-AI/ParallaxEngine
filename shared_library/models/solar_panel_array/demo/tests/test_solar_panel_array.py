from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("solar_panel_array: the prefab spawns and its model's controls work")
async def test_solar_panel_array(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.solar_panel_array, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tilt", 25.0)
    assert abs(model.joint("tilt") - 25.0) < 1e-3
    model.set_option("cells", "poly")
    assert model.option("cells") == "poly"
    assert model.socket_position("socket_combiner").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
