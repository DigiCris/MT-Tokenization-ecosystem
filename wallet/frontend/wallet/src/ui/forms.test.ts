// @vitest-environment jsdom
// P18: los valores de los formularios de operación (token de Enviar, sentido del Swap) salen de grupos de radios y
// selects además de inputs; un grupo de radios devuelve el elegido.
import { describe, expect, it } from 'vitest';
import { formValue } from './forms.tsx';

function input(attributes: Record<string, string>, checked = false): HTMLInputElement {
  const element = document.createElement('input');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.checked = checked;
  return element;
}

describe('formValue', () => {
  it('grupo de radios: el elegido; input, select y textarea: su valor; inexistente: vacío', () => {
    const form = document.createElement('form');
    const select = document.createElement('select');
    select.name = 'destination';
    select.append(new Option('A', '0xabc', true, true));
    const note = document.createElement('textarea');
    note.name = 'note';
    note.value = 'hola';
    form.append(
      input({ type: 'radio', name: 'token', value: 'USDC' }),
      input({ type: 'radio', name: 'token', value: 'USDT' }, true),
      input({ name: 'amount', value: '1,5' }),
      select,
      note,
    );
    expect(formValue(form, 'token')).toBe('USDT');
    expect(formValue(form, 'amount')).toBe('1,5');
    expect(formValue(form, 'destination')).toBe('0xabc');
    expect(formValue(form, 'note')).toBe('hola');
    expect(formValue(form, 'missing')).toBe('');
  });
});
