from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jacuzzi_tub: the prefab spawns and its model's controls work")
async def test_jacuzzi_tub(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jacuzzi_tub, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("access", 0.09)
    assert abs(model.joint("access") - 0.09) < 1e-3
    model.set_option("fill", "empty")
    assert model.option("fill") == "empty"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
