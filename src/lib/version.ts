// Version de l'application (commit git injecté au build) comparée au dernier commit de la branche principale sur GitHub.
import { useEffect, useState } from 'react';

export const REPO = 'sivelswhy/navicharts';
const BRANCH = 'main';
const CACHE_KEY = 'navicharts:latest-commit';
// L'API GitHub sans authentification est limitée à 60 requêtes par heure : une vérification toutes les 10 minutes
const CACHE_MS = 10 * 60 * 1000;

export const APP_COMMIT = __APP_COMMIT__;
export const APP_COMMIT_DATE = __APP_COMMIT_DATE__;
export const APP_DIRTY = __APP_DIRTY__;

export interface LatestCommit {
  sha: string;
  date: string;
  message: string;
  /** Commits publiés depuis celui de l'application (null : inconnu) */
  behindBy: number | null;
  /** Le commit de l'application n'existe pas sur GitHub (pas encore poussé) */
  unpublished: boolean;
}

export type VersionStatus =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; latest: LatestCommit; upToDate: boolean };

async function fetchLatest(): Promise<LatestCommit> {
  const api = (path: string) => fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers: { Accept: 'application/vnd.github+json' } });
  const res = await api(`commits/${BRANCH}`);
  if (!res.ok) throw new Error(`GitHub : HTTP ${res.status}`);
  const c = (await res.json()) as { sha: string; commit: { message: string; committer: { date: string } } };
  const latest: LatestCommit = { sha: c.sha, date: c.commit.committer.date, message: c.commit.message.split('\n')[0], behindBy: 0, unpublished: false };
  if (APP_COMMIT && c.sha !== APP_COMMIT) {
    // Écart entre le commit de l'application et la branche publiée
    const cmp = await api(`compare/${APP_COMMIT}...${BRANCH}`);
    if (cmp.status === 404) return { ...latest, behindBy: null, unpublished: true };
    latest.behindBy = cmp.ok ? ((await cmp.json()) as { ahead_by: number }).ahead_by : null;
  }
  return latest;
}

function cached(): LatestCommit | null {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; app: string; latest: LatestCommit } | null;
    return hit && hit.app === APP_COMMIT && Date.now() - hit.at < CACHE_MS ? hit.latest : null;
  } catch {
    return null;
  }
}

/** État de la version : à jour si le commit de l'application est le dernier commit publié sur GitHub */
export function useVersionStatus(): VersionStatus {
  const [state, setState] = useState<VersionStatus>(() => {
    const hit = cached();
    return hit ? { status: 'ok', latest: hit, upToDate: hit.sha === APP_COMMIT } : { status: 'loading' };
  });
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      const hit = cached();
      if (hit) return setState({ status: 'ok', latest: hit, upToDate: hit.sha === APP_COMMIT });
      fetchLatest().then(
        (latest) => {
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), app: APP_COMMIT, latest }));
          } catch {
            // vérification non mémorisée
          }
          if (!cancelled) setState({ status: 'ok', latest, upToDate: latest.sha === APP_COMMIT });
        },
        () => !cancelled && setState({ status: 'error' }),
      );
    };
    check();
    const timer = setInterval(check, CACHE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}
