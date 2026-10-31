from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("irrigation_sprinkler: the prefab spawns and its model's controls work")
async def test_irrigation_sprinkler(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.irrigation_sprinkler, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("impact_arm", 0.0)
    assert abs(model.joint("impact_arm") - 0.0) < 1e-3
    model.set_option("stand", "yellow")
    assert model.option("stand") == "yellow"
    assert model.socket_position("socket_hose").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
