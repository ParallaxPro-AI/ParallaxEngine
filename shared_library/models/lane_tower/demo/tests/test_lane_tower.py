from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lane_tower: the prefab spawns and its model's controls work")
async def test_lane_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lane_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("barrel_pitch", -9.0)
    assert abs(model.joint("barrel_pitch") - -9.0) < 1e-3
    model.set_option("team", "blue")
    assert model.option("team") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
