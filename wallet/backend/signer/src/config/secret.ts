// Valor sensible: no se serializa, no se imprime y no aparece en inspecciones ni en logs. Sólo `reveal()` lo expone,
// en el punto exacto donde se usa.
import { inspect } from 'node:util';

const REDACTED = '[secreto]';

export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
