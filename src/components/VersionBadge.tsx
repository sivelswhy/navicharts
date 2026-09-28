import { useEffect, useRef, useState } from 'react';
import { APP_COMMIT, APP_COMMIT_DATE, APP_DIRTY, REPO, useVersionStatus } from '../lib/version.ts';

const short = (sha: string) => sha.slice(0, 7);
const when = (iso: string) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const commitUrl = (sha: string) => `https://github.com/${REPO}/commit/${sha}`;

/** Version de l'application dans le rail : commit installé, comparé au dernier commit publié sur GitHub */
export function VersionBadge() {
  const version = useVersionStatus();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const state =
    version.status !== 'ok' || !APP_COMMIT
      ? 'unknown'
      : version.latest.unpublished
        ? 'unpublished'
        : version.upToDate
          ? 'current'
          : 'outdated';
  const summary = {
    unknown: version.status === 'loading' ? 'Vérification…' : 'Impossible de vérifier',
    current: 'À jour',
    outdated: 'Mise à jour disponible',
    unpublished: 'Version locale non publiée',
  }[state];

  return (
    <div className="version" ref={ref}>
      <button
        className={`version-button ${state}`}
        onClick={() => setOpen((o) => !o)}
        title={`Version ${APP_COMMIT ? short(APP_COMMIT) : 'inconnue'} : ${summary.toLowerCase()}`}
        aria-expanded={open}
      >
        <span className="version-dot" aria-hidden />
        <span className="version-sha">{APP_COMMIT ? short(APP_COMMIT) : '?'}</span>
      </button>
      {open && (
        <div className="version-popover" role="dialog" aria-label="Version de l’application">
          <div className={`version-status ${state}`}>
            <span className="version-dot" aria-hidden />
            {summary}
          </div>
          <dl className="version-facts">
            <div>
              <dt>Application</dt>
              <dd>
                {APP_COMMIT ? (
                  <a href={commitUrl(APP_COMMIT)} target="_blank" rel="noreferrer" className="mono">
                    {short(APP_COMMIT)}
                  </a>
                ) : (
                  'commit inconnu'
                )}
                {APP_COMMIT_DATE && <span className="version-date"> · {when(APP_COMMIT_DATE)}</span>}
              </dd>
            </div>
            {version.status === 'ok' && (
              <div>
                <dt>GitHub (main)</dt>
                <dd>
                  <a href={commitUrl(version.latest.sha)} target="_blank" rel="noreferrer" className="mono">
                    {short(version.latest.sha)}
                  </a>
                  <span className="version-date"> · {when(version.latest.date)}</span>
                  <div className="version-message">{version.latest.message}</div>
                </dd>
              </div>
            )}
          </dl>
          {state === 'outdated' && (
            <p className="version-note">
              {version.status === 'ok' && version.latest.behindBy
                ? `${version.latest.behindBy} commit${version.latest.behindBy > 1 ? 's' : ''} publié${version.latest.behindBy > 1 ? 's' : ''} depuis cette version.`
                : 'Une version plus récente est publiée sur GitHub.'}
            </p>
          )}
          {state === 'unpublished' && <p className="version-note">Ce commit n’est pas encore poussé sur GitHub.</p>}
          {APP_DIRTY && <p className="version-note">Modifications locales non commitées.</p>}
        </div>
      )}
    </div>
  );
}
