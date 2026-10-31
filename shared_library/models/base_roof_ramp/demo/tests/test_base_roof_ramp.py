from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("base_roof_ramp: the prefab spawns and its model's controls work")
async def test_base_roof_ramp(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.base_roof_ramp, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("tier", "stone")
    assert model.option("tier") == "stone"
    assert model.socket_position("socket_eave").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
