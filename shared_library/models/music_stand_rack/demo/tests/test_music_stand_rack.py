from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("music_stand_rack: the prefab spawns and its model's controls work")
async def test_music_stand_rack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.music_stand_rack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stand_colour", "black")
    assert model.option("stand_colour") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
