from parallax import Behavior, Shape, behavior

from game.components import Chef


@behavior("carried_item", requires=[Chef])
class CarriedItem(Behavior):
    """Shows what the chef is holding: the little shape on their `carried` child, styled
    from the item (the template's carry prop over the chef's head)."""

    def late_update(self, ctx, dt):
        held = self.entity.get(Chef).held
        prop = self.entity.child("carried")
        prop.visible = held is not None
        if held is None:
            return
        shape = prop.get(Shape)
        shape.kind = held.data.carry_shape
        shape.color = held.data.carry_color
        shape.size = held.data.carry_size
