import { DialogV2, KbdV2 } from '@corefoundry-labs/forge-ui';

type Row = { keys: string[]; label: string };
export const SHORTCUTS: { title: string; rows: Row[] }[] = [
  { title: 'Navegación', rows: [
    { keys: ['←', '→'], label: 'Frame anterior / siguiente' },
    { keys: ['Shift', '←  →'], label: 'Saltar 10 frames' },
    { keys: ['P', 'N'], label: 'Anterior / siguiente de la cola' },
    { keys: ['G'], label: 'Ir a un frame' },
  ] },
  { title: 'Herramientas', rows: [
    { keys: ['V'], label: 'Seleccionar y mover' },
    { keys: ['A'], label: 'Añadir una caja' },
    { keys: ['H'], label: 'Desplazar la vista (o Espacio y arrastrar)' },
    { keys: ['Z'], label: 'Zoom (clic acerca, Shift y clic aleja; también la rueda)' },
    { keys: ['0', '1'], label: 'Ajustar a la vista / 100 %' },
  ] },
  { title: 'Decisiones', rows: [
    { keys: ['C'], label: 'Confirmar la caja' },
    { keys: ['R'], label: 'Rechazar la caja' },
    { keys: ['Supr'], label: 'Quitar la decisión' },
    { keys: ['F'], label: 'Marcar frame completo' },
    { keys: ['Ctrl', 'Z'], label: 'Deshacer' },
    { keys: ['Esc'], label: 'Soltar la selección' },
  ] },
  { title: 'Vista', rows: [
    { keys: ['B'], label: 'Mostrar / ocultar cajas' },
    { keys: ['I'], label: 'Mostrar / ocultar identificadores' },
    { keys: ['?'], label: 'Abrir esta ayuda' },
  ] },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <DialogV2 open={open} onOpenChange={onOpenChange} size="lg" title="Atajos de teclado" description="Funcionan con el foco fuera de un campo de texto.">
      <div className="ann-shortcuts">
        {SHORTCUTS.map(group => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="ann-label">{group.title.toUpperCase()}</h3>
            <dl>
              {group.rows.map(row => (
                <div key={row.label}>
                  <dt>{row.keys.map(key => <KbdV2 key={key} size="md">{key}</KbdV2>)}</dt>
                  <dd>{row.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </DialogV2>
  );
}
