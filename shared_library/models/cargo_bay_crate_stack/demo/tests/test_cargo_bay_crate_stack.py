from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cargo_bay_crate_stack: the prefab spawns and its model's controls work")
async def test_cargo_bay_crate_stack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cargo_bay_crate_stack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("case_d_lid", 50.0)
    assert abs(model.joint("case_d_lid") - 50.0) < 1e-3
    model.set_option("paint", "orange")
    assert model.option("paint") == "orange"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
