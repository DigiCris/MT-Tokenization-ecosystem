// expect: no-restricted-syntax
export function write(html: string): void {
  document.write(html);
}
