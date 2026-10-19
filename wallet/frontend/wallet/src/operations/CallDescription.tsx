// Una operación descripta en partes (describe.ts): el monto y el token destacados y cada dirección completa en
// monoespaciada (AddressText) con el nombre que le conoce la app adelante.
import { Fragment } from 'react';
import { AddressText } from '../ui/AddressText.tsx';
import type { DescriptionPart } from './describe.ts';

export function CallDescription({ parts }: { parts: readonly DescriptionPart[] }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.kind === 'text') return <Fragment key={i}>{part.text}</Fragment>;
        if (part.kind === 'amount') {
          return (
            <strong key={i} className="review__amount">
              {part.text}
            </strong>
          );
        }
        return (
          <span key={i} className="party">
            {part.name !== null && (
              <>
                <span className="party__name">{part.name}</span>{' '}
              </>
            )}
            <AddressText address={part.address} />
          </span>
        );
      })}
    </>
  );
}
