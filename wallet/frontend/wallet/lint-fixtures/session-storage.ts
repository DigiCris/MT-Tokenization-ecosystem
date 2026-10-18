// expect: no-restricted-properties
export function remember(value: string): void {
  window.sessionStorage.setItem('mtw', value);
}
