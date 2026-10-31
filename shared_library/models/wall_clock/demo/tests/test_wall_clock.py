from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wall_clock: the prefab spawns and its model's controls work")
async def test_wall_clock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wall_clock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hour_hand", 30.0)
    assert abs(model.joint("hour_hand") - 30.0) < 1e-3
    model.set_option("face", "dark")
    assert model.option("face") == "dark"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
