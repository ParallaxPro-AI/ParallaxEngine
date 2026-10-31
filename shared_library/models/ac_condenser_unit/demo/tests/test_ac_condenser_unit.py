from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ac_condenser_unit: the prefab spawns and its model's controls work")
async def test_ac_condenser_unit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ac_condenser_unit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("mount", "wall")
    assert model.option("mount") == "wall"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
