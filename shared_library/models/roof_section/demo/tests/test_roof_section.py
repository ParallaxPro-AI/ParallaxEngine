from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("roof_section: the prefab spawns and its model's controls work")
async def test_roof_section(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.roof_section, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("roof_type", "flat")
    assert model.option("roof_type") == "flat"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
