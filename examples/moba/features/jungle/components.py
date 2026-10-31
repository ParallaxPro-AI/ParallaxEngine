from parallax import ContentRef, component, field

from game.content import CampDef


@component("camp")
class Camp:
    kind: ContentRef[CampDef] = field()
