from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("archery_target: the prefab spawns and its model's controls work")
async def test_archery_target(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.archery_target, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stand", "oak")
    assert model.option("stand") == "oak"
    assert model.socket_position("socket_bullseye").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
