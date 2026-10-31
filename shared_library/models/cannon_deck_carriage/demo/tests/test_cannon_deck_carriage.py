from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cannon_deck_carriage: the prefab spawns and its model's controls work")
async def test_cannon_deck_carriage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cannon_deck_carriage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gun", 0.55)
    assert abs(model.joint("gun") - 0.55) < 1e-3
    model.set_option("carriage", "natural")
    assert model.option("carriage") == "natural"
    assert model.socket_position("loader").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
