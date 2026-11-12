/**
 * Statement regions wrapped in these comments are host adapters for Node,
 * QX, Loon, Stash, Shadowrocket, Egern, and GUI.for.Cores. The Surge bundle
 * deletes the regions before esbuild parses the file. Other builds leave
 * the comments in place, so the statements run exactly as written.
 *
 * Markers wrap complete statements. They are not nested.
 */
const REGION_RE =
    /\/\*[ \t]*@non-surge-start[ \t]*\*\/[\s\S]*?\/\*[ \t]*@non-surge-end[ \t]*\*\//g;

function stripNonSurgeRegions(source, filename = 'source') {
    const hasMarker =
        source.includes('@non-surge-start') ||
        source.includes('@non-surge-end');
    if (!hasMarker) return source;

    const next = source.replace(REGION_RE, '');
    if (
        next.includes('@non-surge-start') ||
        next.includes('@non-surge-end')
    ) {
        throw new Error(
            `unbalanced @non-surge marker in ${filename}`,
        );
    }
    return next;
}

module.exports = {
    stripNonSurgeRegions,
};
