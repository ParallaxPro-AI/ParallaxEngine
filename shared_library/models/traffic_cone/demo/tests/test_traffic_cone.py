from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("traffic_cone: the prefab spawns and its model's controls work")
async def test_traffic_cone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.traffic_cone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("trim", "night")
    assert model.option("trim") == "night"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
