from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cereal_box: the prefab spawns and its model's controls work")
async def test_cereal_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cereal_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flap_front", 60.0)
    assert abs(model.joint("flap_front") - 60.0) < 1e-3
    model.set_option("print", "orange")
    assert model.option("print") == "orange"
    await game.advance(seconds=1)
