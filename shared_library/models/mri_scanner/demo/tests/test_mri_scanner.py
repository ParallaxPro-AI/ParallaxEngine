from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mri_scanner: the prefab spawns and its model's controls work")
async def test_mri_scanner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mri_scanner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("table_height", -0.125)
    assert abs(model.joint("table_height") - -0.125) < 1e-3
    model.set_option("accent", "teal")
    assert model.option("accent") == "teal"
    assert model.socket_position("socket_patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
