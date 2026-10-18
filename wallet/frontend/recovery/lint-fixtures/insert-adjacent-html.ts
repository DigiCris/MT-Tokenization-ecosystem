// expect: no-restricted-syntax
export function append(target: HTMLElement, html: string): void {
  target.insertAdjacentHTML('beforeend', html);
}
