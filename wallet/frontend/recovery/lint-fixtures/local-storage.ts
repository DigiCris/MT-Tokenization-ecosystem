// expect: no-restricted-globals
export function remember(value: string): void {
  localStorage.setItem('mtw', value);
}
