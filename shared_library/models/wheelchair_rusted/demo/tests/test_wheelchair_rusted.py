from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wheelchair_rusted: the prefab spawns and its model's controls work")
async def test_wheelchair_rusted(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wheelchair_rusted, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("footrest_l", 42.5)
    assert abs(model.joint("footrest_l") - 42.5) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
