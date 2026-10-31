from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("prison_bunk_steel: the prefab spawns and its model's controls work")
async def test_prison_bunk_steel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.prison_bunk_steel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("mattress", "blue")
    assert model.option("mattress") == "blue"
    assert model.socket_position("socket_bunk_lower").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
