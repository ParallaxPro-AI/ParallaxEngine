from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("office_block: the prefab spawns and its model's controls work")
async def test_office_block(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.office_block, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 45.0)
    assert abs(model.joint("door") - 45.0) < 1e-3
    model.set_option("glass_tint", "blue")
    assert model.option("glass_tint") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
