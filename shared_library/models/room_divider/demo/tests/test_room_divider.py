from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("room_divider: the prefab spawns and its model's controls work")
async def test_room_divider(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.room_divider, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("panel_2", 30.0)
    assert abs(model.joint("panel_2") - 30.0) < 1e-3
    model.set_option("panel_count", "three")
    assert model.option("panel_count") == "three"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
