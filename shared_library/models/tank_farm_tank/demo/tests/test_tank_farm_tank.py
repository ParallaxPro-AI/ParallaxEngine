from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tank_farm_tank: the prefab spawns and its model's controls work")
async def test_tank_farm_tank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tank_farm_tank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("manway", 50.0)
    assert abs(model.joint("manway") - 50.0) < 1e-3
    model.set_option("paint", "silver")
    assert model.option("paint") == "silver"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
