from parallax import Behavior, Model, behavior

from game.content import ServiceRules


@behavior("chef_look", requires=[Model])
class ChefLook(Behavior):
    """Gives this seat's chef its own character model (the template's chef_p1 / chef_p2).
    Both seats spawn from one prefab and a PlayerStart can't carry per-seat overrides
    (see NOTES.md)."""

    def start(self, ctx):
        models = ctx.config(ServiceRules).chef_models
        self.entity.get(Model).model = models[self.entity.owner.index % len(models)]
