from parallax.test import playtest


@playtest("the block is drawn")
async def test_drawn(game):
    await game.start()
    await game.advance(frames=2)
    seen = game.observe()
    block = [e for e in seen["entities"] if e["placedId"] == "block"][0]
    assert block["onScreen"], "the block is on screen"
    assert seen["camera"]["dimension"] == "2d"
    drawn = game.observe(entities="drawn")
    assert len(drawn["entities"]) <= len(seen["entities"])


@playtest("a failing playtest still reports what the game showed")
async def test_fails(game):
    await game.start()
    await game.advance(frames=1)
    assert 1 == 2, "deliberately failing"


def test_plain():
    assert 1 + 1 == 2
