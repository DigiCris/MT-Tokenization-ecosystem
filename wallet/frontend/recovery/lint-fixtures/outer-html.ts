// expect: no-restricted-syntax
export function replace(target: HTMLElement, html: string): void {
  target['outerHTML'] = html;
}
