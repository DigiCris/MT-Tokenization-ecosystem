// Envoltorio de secretos: el valor sólo sale con reveal(). Serializar o inspeccionar la configuración (logs, errores,
// JSON) nunca muestra el contenido.
import { inspect } from 'node:util';

export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return 'Secret([REDACTED])';
  }
}
