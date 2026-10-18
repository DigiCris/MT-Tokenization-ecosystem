// expect: no-eval
export function run(code: string): unknown {
  return eval(code);
}
