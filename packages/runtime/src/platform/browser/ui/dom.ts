/**
 * The slice of the DOM the panel binder uses. The page's `document` and elements satisfy
 * it structurally; `binding.test.ts` drives the binder with a small fake that counts writes, so
 * the binding and diffing rules are tested without a browser.
 */

export interface DomNode {
  readonly parentNode: DomNode | null;
  textContent: string | null;
  remove(): void;
}

export interface DomElement extends DomNode {
  readonly tagName: string;
  readonly classList: { toggle(token: string, force?: boolean): boolean };
  readonly style: { setProperty(name: string, value: string, priority?: string): void; removeProperty(name: string): string };
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild<T extends DomNode>(node: T): T;
  insertBefore<T extends DomNode>(node: T, before: DomNode | null): T;
}

export interface DomDocument {
  createElement(tag: string): DomElement;
  createElementNS(namespace: string, tag: string): DomElement;
  createTextNode(text: string): DomNode;
}

/** Where built elements go: an element, or a shadow root. */
export interface DomParent {
  appendChild<T extends DomNode>(node: T): T;
  insertBefore<T extends DomNode>(node: T, before: DomNode | null): T;
}

/**
 * Focus without the focus-visible ring (a modal opening) or with it (keyboard / gamepad
 * navigation). `focusVisible` is not in TypeScript's lib.dom yet; a browser without it ignores it.
 */
export const QUIET_FOCUS = { preventScroll: true, focusVisible: false } as FocusOptions;
export const VISIBLE_FOCUS = { preventScroll: true, focusVisible: true } as FocusOptions;
