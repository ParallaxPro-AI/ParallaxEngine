from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("extra_life_token: the prefab spawns and its model's controls work")
async def test_extra_life_token(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.extra_life_token, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
