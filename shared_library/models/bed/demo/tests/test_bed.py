from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bed: the prefab spawns and its model's controls work")
async def test_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("size", "single")
    assert model.option("size") == "single"
    assert model.socket_position("socket_pillow").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
