from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("robot_arm: the prefab spawns and its model's controls work")
async def test_robot_arm(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.robot_arm, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shoulder", 17.5)
    assert abs(model.joint("shoulder") - 17.5) < 1e-3
    model.set_option("finish", "lab")
    assert model.option("finish") == "lab"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
