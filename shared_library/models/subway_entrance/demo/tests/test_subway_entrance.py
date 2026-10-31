from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("subway_entrance: the prefab spawns and its model's controls work")
async def test_subway_entrance(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.subway_entrance, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shutter_curtain", 10.5)
    assert abs(model.joint("shutter_curtain") - 10.5) < 1e-3
    model.set_option("livery", "green")
    assert model.option("livery") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
