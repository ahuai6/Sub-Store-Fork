/**
 * Opt-in Surge prefetch cron.
 *
 * The published Surge beta module adds `prefetch_cron` with a default schedule but a disabled task name.
 * An empty schedule does not produce subscriptions and does not fall through
 * to Gist sync. When the schedule is set, the cron calls produceArtifact for
 * the named subs and collections, which fills the output cache. That cache
 * still expires with resourceCacheTtl.
 *
 * Enable it in the module parameters:
 * 1. Set prefetch from "# Sub-Store Prefetch" to "Sub-Store Prefetch".
 * 2. Set prefetch_cron to a cron expression, for example "50 3 * * *".
 * 3. Set prefetch_sub and/or prefetch_col to the saved names; leave the other
 *    at its default "off". No prefetch parameters need editing for installation.
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

// Only prefetch target lists treat literal "off" as no selection. Decode after
// filtering so an actual subscription called "off" can be selected with %6Fff.
export function prefetchNames(value) {
    return `${value ?? ''}`
        .split(/,|，/g)
        .map((name) => name.trim())
        .filter((name) => name && name.toLowerCase() !== 'off')
        .map((name) => decodeURIComponent(name));
}
