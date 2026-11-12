/**
 * Opt-in Surge prefetch cron.
 *
 * The published Surge beta module adds `prefetch_cron`, empty by default.
 * An empty schedule does not produce subscriptions and does not fall through
 * to Gist sync. When the schedule is set, the cron calls produceArtifact for
 * the named subs and collections, which fills the output cache. That cache
 * still expires with resourceCacheTtl.
 *
 * Enable it in the module parameters:
 * 1. Set prefetch from "# Sub-Store Prefetch" to "Sub-Store Prefetch".
 * 2. Set prefetch_cron to a cron expression, for example "50 3 * * *".
 * 3. Set prefetch_sub and/or prefetch_col to the saved names.
 * The warmed target is Surge unless prefetch_platform is changed.
 */

const DISABLED = new Set(['false', '0', 'no', 'off']);

export function prefetchDecision(arg) {
    if (!arg || typeof arg !== 'object') return { handled: false };
    if (!Object.prototype.hasOwnProperty.call(arg, 'prefetch')) {
        return { handled: false };
    }
    const flag = `${arg.prefetch ?? ''}`.trim().toLowerCase();
    if (!flag || DISABLED.has(flag)) return { handled: false };
    const schedule = `${arg.cron ?? ''}`.trim();
    if (!schedule) {
        return {
            handled: true,
            run: false,
            reason: 'prefetch_cron is empty',
        };
    }
    const platform = `${arg.platform || 'Surge'}`.trim() || 'Surge';
    return { handled: true, run: true, platform, reason: '' };
}
