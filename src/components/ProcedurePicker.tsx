export interface PickerItem {
  key: string;
  label: string;
  title: string;
  /** Groupe d'affichage : point de transition d'une SID ou STAR (AGOPA), piste d'une approche (14L) */
  group: string;
}

interface Props {
  /** « SID », « STAR », « Approches » */
  title: string;
  /** Couleur des pastilles actives : sid, star ou app */
  variant: 'sid' | 'star' | 'app';
  items: PickerItem[] | 'loading';
  shown: Set<string>;
  onToggle: (key: string) => void;
  onShowAll: (keys: string[], show: boolean) => void;
  /** Libellé d'un groupe (« Piste 14L ») */
  groupLabel?: (group: string) => string;
  /** Remarque sous les pastilles */
  note?: string;
}

/** Procédures de l'aérodrome (SID, STAR, approches) à afficher sur la carte, regroupées par point ou par piste */
export function ProcedurePicker({ title, variant, items, shown, onToggle, onShowAll, groupLabel = (g) => g, note }: Props) {
  if (items === 'loading') return <p className="placeholder procedure-picker-status">Chargement des {title}…</p>;
  if (!items.length) return null;
  const keys = items.map((i) => i.key);
  const shownCount = keys.filter((k) => shown.has(k)).length;
  const groups = new Map<string, PickerItem[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr', { numeric: true }));

  return (
    <section className={`procedure-picker procedure-picker-${variant}`}>
      <header className="procedure-picker-head">
        <h3 className="list-heading">
          {title} sur la carte
          {shownCount > 0 && <span className="procedure-picker-count"> · {shownCount} affichée{shownCount > 1 ? 's' : ''}</span>}
        </h3>
        <button className="link-button" onClick={() => onShowAll(keys, shownCount < keys.length)}>
          {shownCount < keys.length ? 'Tout afficher' : 'Tout masquer'}
        </button>
      </header>
      <div className="procedure-groups" role="group" aria-label={`${title} à afficher sur la carte`}>
        {sorted.map(([group, list]) => {
          const groupKeys = list.map((i) => i.key);
          const allShown = groupKeys.every((k) => shown.has(k));
          return (
            <div key={group} className="procedure-group">
              <button
                className={allShown ? 'procedure-group-name on' : 'procedure-group-name'}
                onClick={() => onShowAll(groupKeys, !allShown)}
                title={allShown ? `Masquer ${groupLabel(group)}` : `Afficher tout ${groupLabel(group)}`}
              >
                {groupLabel(group)}
              </button>
              <div className="procedure-chips">
                {list.map((item) => {
                  const on = shown.has(item.key);
                  return (
                    <button
                      key={item.key}
                      className={on ? 'procedure-chip on' : 'procedure-chip'}
                      aria-pressed={on}
                      onClick={() => onToggle(item.key)}
                      title={item.title}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {note && <p className="procedure-picker-note">{note}</p>}
    </section>
  );
}
