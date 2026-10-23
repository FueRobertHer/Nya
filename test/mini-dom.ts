// A small document for rendering a component with react-dom/client in a test,
// so a test can click, type and see what the page then does (the Plan tab's
// scenario lifecycle, test/plan-tab-scenarios.test.tsx). Only what React and
// these components touch: elements, text, attributes, styles, focus, and
// events dispatched from a target up through its ancestors. No layout.
//
// installDom() puts `window`, `document` and the few globals React reads on
// globalThis, and returns a function that takes them all away again: every
// test file runs in one process, and the next file must find no browser,
// as lib/format.ts and components/hide-amounts.ts expect where there is none.

type Listener = { fn: (e: FakeEvent) => void; capture: boolean };

export class FakeEvent {
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  eventPhase = 0;
  defaultPrevented = false;
  propagationStopped = false;
  timeStamp = Date.now();
  isTrusted = true;
  button = 0;
  detail = 1;
  key?: string;
  constructor(
    readonly type: string,
    readonly bubbles = true,
    readonly cancelable = true
  ) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.propagationStopped = true;
  }
}

export class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners = new Map<string, Listener[]>();
  constructor(
    readonly nodeType: number,
    public ownerDocument: FakeDocument | null
  ) {}
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) - 1] ?? null) : null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n) {
      if (n.nodeType === 9) return true;
      n = n.parentNode;
    }
    return false;
  }
  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(n: FakeNode | null): boolean {
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v) this.appendChild(new FakeText(String(v), this.ownerDocument));
  }
  addEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => !(l.fn === fn && l.capture === capture))
    );
  }
  /** Dispatches from this node: capture down from the top, then bubble up. */
  dispatchEvent(e: FakeEvent): boolean {
    e.target = this;
    const path: FakeNode[] = [];
    for (let n: FakeNode | null = this; n; n = n.parentNode) path.push(n);
    const win = this.ownerDocument?.defaultView as unknown as FakeNode | undefined;
    if (win) path.push(win);
    const call = (n: FakeNode, capture: boolean) => {
      e.currentTarget = n;
      for (const l of [...(n.listeners.get(e.type) ?? [])]) if (l.capture === capture) l.fn(e);
    };
    for (let i = path.length - 1; i >= 0 && !e.propagationStopped; i--) call(path[i], true);
    for (let i = 0; i < path.length && !e.propagationStopped; i++) {
      if (i > 0 && !e.bubbles) break;
      call(path[i], false);
    }
    return !e.defaultPrevented;
  }
}

export class FakeText extends FakeNode {
  constructor(
    public data: string,
    doc: FakeDocument | null
  ) {
    super(3, doc);
  }
  get nodeValue() {
    return this.data;
  }
  set nodeValue(v: string) {
    this.data = v;
  }
  override get textContent() {
    return this.data;
  }
  override set textContent(v: string) {
    this.data = v;
  }
}

class FakeComment extends FakeNode {
  constructor(
    public data: string,
    doc: FakeDocument | null
  ) {
    super(8, doc);
  }
  override get textContent() {
    return '';
  }
}

function styleObject(): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  Object.defineProperties(s, {
    setProperty: { value: (k: string, v: string) => (s[k] = v), enumerable: false },
    removeProperty: { value: (k: string) => delete s[k], enumerable: false },
    getPropertyValue: { value: (k: string) => s[k] ?? '', enumerable: false },
  });
  return s;
}

export class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  style = styleObject();
  dataset: Record<string, string> = {};
  value = '';
  checked = false;
  disabled = false;
  scrollTop = 0;
  scrollLeft = 0;
  constructor(
    readonly tagName: string,
    doc: FakeDocument | null,
    readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  ) {
    super(1, doc);
  }
  get nodeName() {
    return this.tagName;
  }
  get localName() {
    return this.tagName.toLowerCase();
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
    if (k === 'disabled') this.disabled = true;
  }
  setAttributeNS(_ns: string | null, k: string, v: string) {
    this.setAttribute(k, v);
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attributes.has(k);
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
    if (k === 'disabled') this.disabled = false;
  }
  removeAttributeNS(_ns: string | null, k: string) {
    this.removeAttribute(k);
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  /** Every element under this one, in order, matching `test`. */
  findAll(test: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (test(c)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

export class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement;
  defaultView: unknown = null;
  /** React tells a browser that fires "input" by this being there; without
   *  it, it waits for events only old Internet Explorer sends. */
  oninput: null = null;
  constructor() {
    super(9, null);
    this.ownerDocument = null;
    this.documentElement = new FakeElement('HTML', this);
    this.head = new FakeElement('HEAD', this);
    this.body = new FakeElement('BODY', this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag.toUpperCase(), this);
  }
  createElementNS(ns: string, tag: string) {
    return new FakeElement(tag, this, ns);
  }
  createTextNode(text: string) {
    return new FakeText(text, this);
  }
  createComment(text: string) {
    return new FakeComment(text, this);
  }
  getElementById() {
    return null;
  }
}

/** Puts a document and a window on globalThis; returns what takes them away. */
export function installDom(): { document: FakeDocument; uninstall: () => void } {
  const g = globalThis as Record<string, unknown>;
  const names = ['window', 'document', 'navigator', 'HTMLIFrameElement', 'HTMLElement', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage'];
  const before = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)]));
  const document = new FakeDocument();
  const store = new Map<string, string>();
  const win = new FakeNode(0, document) as FakeNode & Record<string, unknown>;
  Object.assign(win, {
    document,
    HTMLIFrameElement: class {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
    },
    location: { href: 'https://nya.test/', origin: 'https://nya.test' },
    getComputedStyle: () => styleObject(),
    scrollTo: () => {},
  });
  document.defaultView = win;
  const set = (name: string, value: unknown) => Object.defineProperty(g, name, { value, configurable: true, writable: true });
  set('window', win);
  set('document', document);
  set('navigator', { userAgent: 'mini-dom' });
  set('HTMLIFrameElement', win.HTMLIFrameElement);
  set('HTMLElement', FakeElement);
  set('Node', FakeNode);
  set('localStorage', win.localStorage);
  set('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  set('cancelAnimationFrame', (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  set('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    document,
    uninstall: () => {
      for (const [name, d] of before) {
        if (d) Object.defineProperty(g, name, d);
        else delete g[name];
      }
    },
  };
}

/** A click on an element, as a person's. */
export function click(el: FakeElement) {
  el.dispatchEvent(new FakeEvent('click'));
}

/** Typing a whole new value into a field. */
export function type(el: FakeElement, value: string) {
  el.value = value;
  el.dispatchEvent(new FakeEvent('input'));
  el.dispatchEvent(new FakeEvent('change'));
}
