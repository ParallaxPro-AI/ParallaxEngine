from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("solar_panel_rooftop: the prefab spawns and its model's controls work")
async def test_solar_panel_rooftop(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.solar_panel_rooftop, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("mount", "tilt")
    assert model.option("mount") == "tilt"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
