from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("riot_shield: the prefab spawns and its model's controls work")
async def test_riot_shield(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.riot_shield, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm_cuff", 20.0)
    assert abs(model.joint("arm_cuff") - 20.0) < 1e-3
    model.set_option("marking", "security")
    assert model.option("marking") == "security"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
