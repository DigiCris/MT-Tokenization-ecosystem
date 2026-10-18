// expect: no-new-func
export function compile(code: string): () => unknown {
  return new Function(code) as () => unknown;
}
