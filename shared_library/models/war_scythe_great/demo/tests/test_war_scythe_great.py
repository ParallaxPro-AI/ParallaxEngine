from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("war_scythe_great: the prefab spawns and its model's controls work")
async def test_war_scythe_great(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.war_scythe_great, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("edge").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
