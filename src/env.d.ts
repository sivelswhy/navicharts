// Constantes injectées au build (voir vite.config.ts)
/** Commit git de l'application (vide s'il est inconnu) */
declare const __APP_COMMIT__: string;
/** Date du commit (ISO 8601) */
declare const __APP_COMMIT_DATE__: string;
/** Modifications locales non commitées au moment du build ou du lancement du serveur de dev */
declare const __APP_DIRTY__: boolean;
