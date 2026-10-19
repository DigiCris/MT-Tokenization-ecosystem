// Impresión de una sección sola (las 17 palabras o el QR del sobre de R: "página dedicada sin otros datos",
// [F-KEY-06].4): la hoja de estilos de impresión oculta todo salvo el elemento marcado.

export function printSection(id: string): void {
  const element = document.getElementById(id);
  if (element === null) return;
  element.classList.add('print-target');
  document.body.classList.add('printing-section');
  const done = () => {
    element.classList.remove('print-target');
    document.body.classList.remove('printing-section');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}
