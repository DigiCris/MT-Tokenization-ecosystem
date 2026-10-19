// DOM sin HTML generado: cada nodo con createElement y su texto con textContent (sin sinks de Trusted Types).
type Child = Node | string | null | false | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function replace(target: Element, ...children: Child[]): void {
  target.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== false && c !== undefined));
}

export function field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLElement {
  const id = `f-${control.name}`;
  control.id = id;
  control.classList.add('input');
  return el('div', { class: 'field' }, el('label', { for: id }, label), control);
}

export function notice(tone: 'info' | 'ok' | 'error', text: string): HTMLElement {
  return el('p', { class: `notice notice--${tone}`, role: tone === 'error' ? 'alert' : 'status' }, text);
}
