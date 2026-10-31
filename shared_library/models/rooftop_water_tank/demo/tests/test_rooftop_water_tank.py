from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rooftop_water_tank: the prefab spawns and its model's controls work")
async def test_rooftop_water_tank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rooftop_water_tank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 50.0)
    assert abs(model.joint("hatch") - 50.0) < 1e-3
    model.set_option("staves", "new_cedar")
    assert model.option("staves") == "new_cedar"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
