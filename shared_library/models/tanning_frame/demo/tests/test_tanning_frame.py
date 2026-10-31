from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tanning_frame: the prefab spawns and its model's controls work")
async def test_tanning_frame(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tanning_frame, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("socket_hide").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
