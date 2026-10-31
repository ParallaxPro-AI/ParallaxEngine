from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("roof_vent_stack: the prefab spawns and its model's controls work")
async def test_roof_vent_stack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.roof_vent_stack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("cap", "turbine")
    assert model.option("cap") == "turbine"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
