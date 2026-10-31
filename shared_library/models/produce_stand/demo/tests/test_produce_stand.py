from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("produce_stand: the prefab spawns and its model's controls work")
async def test_produce_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.produce_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame_finish", "weathered")
    assert model.option("frame_finish") == "weathered"
    assert model.socket_position("socket_header").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
