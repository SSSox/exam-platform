/** Network addresses of the content repository, set at build time by `vite.config.ts` from `content-sources.json`. */
declare const __CONTENT_URLS__: string[];
/** Whether this build ships a content snapshot in `./content` (false for a build with `EXAM_CONTENT_DIR=none`). */
declare const __CONTENT_SNAPSHOT__: boolean;
/** Download addresses of the Windows and Android apps from `downloads.json`; a missing one is not offered. */
declare const __DOWNLOADS__: { windows?: string; android?: string };
