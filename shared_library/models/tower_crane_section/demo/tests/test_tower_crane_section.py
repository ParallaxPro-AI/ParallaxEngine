from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tower_crane_section: the prefab spawns and its model's controls work")
async def test_tower_crane_section(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tower_crane_section, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trolley", 8.7)
    assert abs(model.joint("trolley") - 8.7) < 1e-3
    model.set_option("top", "slewing")
    assert model.option("top") == "slewing"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
