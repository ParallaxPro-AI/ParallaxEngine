"""In-game purchases (plugins.payments()), sold by the page or app hosting the game — the
game never shows a pay button of its own or sees a card. Products are content
(content/product/<id>.json); the host shows its own confirm sheet and charges.

    {"name": "Gem pouch", "kind": "consumable", "price": 100}      # content/product/gems.json

    @resource("stash", keep="profile")
    class Stash:
        gems: int = 0

    if ctx.payments.available:
        ctx.payments.buy(Content.product.gems)

    @on(PurchaseCompleted)
    def granted(self, ctx, e: PurchaseCompleted):
        if e.product == Content.product.gems:
            ctx.get(Stash).gems += 100

Grant in `PurchaseCompleted`: it arrives once per purchase — on a later run, too, if the
game closed first — and is confirmed to the host only after your handlers ran. A
permanent product is owned after it (`owns`), on every device. `available` is False on
servers, offline exports and for guests: hide the store then. Payments are not networked:
they work in single-player and local games only (a net game's server can't buy, and a
purchase on a client isn't forwarded to the server).
"""

from typing import Literal
from parallax import ContentRef, Localized, content, event, field

@content("product")
class ProductDef:
    """Built-in content kind."""
    name: Localized
    description: Localized = field("")
    kind: Literal["consumable", "permanent"] = field("consumable")
    price: int = field(0, min=0, doc="List price in the platform currency (whole units).")

@event("purchase_completed")
class PurchaseCompleted:
    product: ContentRef[ProductDef]
    purchase: str
    """The host's id for this purchase."""

@event("purchase_failed")
class PurchaseFailed:
    product: ContentRef[ProductDef]
    reason: Literal["cancelled", "failed", "already_owned", "unavailable", "pending"]
    message: str
    """Safe to show ("Not enough Plux."); may be empty."""

class PaymentsApi:
    @property
    def available(self) -> bool: ...
    @property
    def test_mode(self) -> bool:
        """Purchases are simulated (editor previews): nothing is charged."""
    @property
    def ready(self) -> bool:
        """The host's prices are in."""
    def buy(self, product: ContentRef[ProductDef]) -> bool:
        """Ask to buy; the answer is PurchaseCompleted or PurchaseFailed. False when it
        couldn't be asked (PurchaseFailed follows)."""
    def owns(self, product: ContentRef[ProductDef]) -> bool: ...
    def price(self, product: ContentRef[ProductDef]) -> str | None:
        """The host's display price ("120 Plux"), or None."""
    def pending(self, product: ContentRef[ProductDef]) -> bool: ...
