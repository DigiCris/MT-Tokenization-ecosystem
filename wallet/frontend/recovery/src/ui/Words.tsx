// Lista numerada de palabras (Password R de 5, backup de 17) para anotar; sin copiar al portapapeles a propósito.
export function Words({ words, label }: { words: readonly string[]; label: string }) {
  return (
    <ol className="words" aria-label={label}>
      {words.map((word, i) => (
        <li key={`${String(i)}-${word}`} className="words__item">
          <span className="words__index">{i + 1}</span> <span className="words__word">{word}</span>
        </li>
      ))}
    </ol>
  );
}
