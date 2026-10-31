from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("neon_kanji_free_sign_vertical: the prefab spawns and its model's controls work")
async def test_neon_kanji_free_sign_vertical(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.neon_kanji_free_sign_vertical, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("glyph_colour", "amber")
    assert model.option("glyph_colour") == "amber"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
