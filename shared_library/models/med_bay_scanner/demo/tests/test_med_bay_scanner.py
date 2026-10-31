from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("med_bay_scanner: the prefab spawns and its model's controls work")
async def test_med_bay_scanner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.med_bay_scanner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("scanner_arch", 0.625)
    assert abs(model.joint("scanner_arch") - 0.625) < 1e-3
    model.set_option("hull", "grey")
    assert model.option("hull") == "grey"
    assert model.socket_position("bed_patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
