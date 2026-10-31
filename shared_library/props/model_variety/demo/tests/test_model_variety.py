from parallax import Model
from parallax.test import playtest
from project import Scenes


def looks(game):
    return [(e.get(Model).option("paint"), e.get(Model).option("topper"), round(e.transform.scale.x, 4))
            for e, _ in game.world.query(Model)]


@playtest("copies of one prefab get different looks: every option varies, within its list and the height spread")
async def test_variety(game):
    await game.start(scene=Scenes.yard, seed=7)
    await game.advance(frames=1)
    seen = looks(game)
    assert len(seen) == 16
    assert len(set(seen)) > 6
    assert all(paint in ("blue", "green") and topper in ("antenna", "dish") for paint, topper, _ in seen)
    assert {topper for _, topper, _ in seen} == {"antenna", "dish"}
    assert all(0.9 <= scale <= 1.1 for _, _, scale in seen)


@playtest("the same seed dresses the same crowd")
async def test_deterministic(game):
    await game.start(scene=Scenes.yard, seed=7)
    await game.advance(frames=1)
    first = looks(game)
    game.ctx.scenes.reload(seed=7)
    await game.advance(frames=2)
    assert looks(game) == first
