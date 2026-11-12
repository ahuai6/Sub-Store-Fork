/* global __SURGE_ONLY__, $platform */

/**
 * Compile-time host pin for the Surge script bundles.
 *
 * `backend/bundle-esbuild.js` sets esbuild `define` for sub-store-0 and
 * sub-store-1 only:
 *
 *   __SURGE_ONLY__ = true
 *   $platform = "Surge"
 *
 * Every other build defines `__SURGE_ONLY__` as false, so the ternaries fold
 * back to today's runtime detection. Tests and `babel-node` leave the
 * identifier undeclared; `typeof` is then "undefined" and detection stays
 * dynamic. Do not assign to `$platform`: the Surge build replaces that
 * identifier with a string literal.
 */
export const SURGE_ONLY =
    typeof __SURGE_ONLY__ !== 'undefined' && __SURGE_ONLY__ === true;

export const BUILD_PLATFORM = SURGE_ONLY
    ? typeof $platform === 'string'
        ? $platform
        : 'Surge'
    : undefined;
