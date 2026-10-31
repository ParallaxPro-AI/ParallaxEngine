from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("vending_machine: the prefab spawns and its model's controls work")
async def test_vending_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.vending_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("glass_door", 60.0)
    assert abs(model.joint("glass_door") - 60.0) < 1e-3
    model.set_option("product", "drinks")
    assert model.option("product") == "drinks"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
