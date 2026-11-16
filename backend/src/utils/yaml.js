import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const DEFAULT_PARSE_OPTIONS = {
    logLevel: 'error',
    merge: true,
};

function retry(fn, content, ...args) {
    try {
        return fn(content, ...args);
    } catch (e) {
        return fn(
            dump(
                fn(
                    content.replace(/!<str>\s*/g, '__SubStoreJSYAMLString__'),
                    ...args,
                ),
            ).replace(/__SubStoreJSYAMLString__/g, ''),
            ...args,
        );
    }
}

function toSerializable(content) {
    return typeof content === 'string'
        ? content
        : JSON.parse(JSON.stringify(content));
}

function jsonYamlReplacer(key, value) {
    if (typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return null;
    }
    if (
        value !== null &&
        typeof value === 'object' &&
        typeof value.toJSON === 'function'
    ) {
        return value.toJSON(key);
    }
    return value;
}

function normalizeParseOptions(options) {
    return {
        ...DEFAULT_PARSE_OPTIONS,
        ...(options || {}),
    };
}

function normalizeStringifyOptions(options = {}) {
    const {
        forceQuotes,
        lineWidth,
        noArrayIndent,
        noRefs,
        quotingType,
        sortKeys,
        ...rest
    } = options || {};
    const normalized = {
        aliasDuplicateObjects: typeof noRefs === 'boolean' ? !noRefs : false,
        ...rest,
    };

    if (typeof lineWidth === 'number') {
        normalized.lineWidth = lineWidth <= 0 ? 0 : lineWidth;
    }
    if (typeof noArrayIndent === 'boolean') {
        normalized.indentSeq = !noArrayIndent;
    }
    if (typeof sortKeys !== 'undefined') {
        normalized.sortMapEntries = sortKeys;
    }
    if (quotingType === "'") {
        normalized.singleQuote = true;
    } else if (quotingType === '"') {
        normalized.singleQuote = false;
    }
    if (forceQuotes) {
        normalized.defaultStringType =
            quotingType === "'" ? 'QUOTE_SINGLE' : 'QUOTE_DOUBLE';
    }

    return normalized;
}

function parse(content, options) {
    return parseYaml(content, normalizeParseOptions(options));
}

function stringify(content, options) {
    if (content === undefined) {
        return undefined;
    }
    return stringifyYaml(
        content,
        jsonYamlReplacer,
        normalizeStringifyOptions(options),
    );
}

export function safeLoad(content, ...args) {
    return retry(parse, toSerializable(content), ...args);
}
export function load(content, ...args) {
    return retry(parse, toSerializable(content), ...args);
}
export function safeDump(content, ...args) {
    return stringify(content, ...args);
}
export function dump(content, ...args) {
    return stringify(content, ...args);
}

export default {
    safeLoad,
    load,
    safeDump,
    dump,
    parse: safeLoad,
    stringify: safeDump,
};
