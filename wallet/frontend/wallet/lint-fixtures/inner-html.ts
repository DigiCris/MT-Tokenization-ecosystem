// expect: no-restricted-syntax
export function render(target: HTMLElement, html: string): void {
  target.innerHTML = html;
}
