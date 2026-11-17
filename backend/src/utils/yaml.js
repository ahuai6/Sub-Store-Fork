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

// A unique proxy list stays well under this. A shared diamond does not:
// aliasDuplicateObjects:false expands it (depth 18 was 29MB / 2.6s here, and
// deeper graphs run until the script is killed) and a cycle overflows the
// stack instead of returning. Count expanded objects in linear time and alias
// only past the limit, so ordinary shared fields stay duplicated.
const YAML_EXPAND_OBJECT_LIMIT = 65536;

function expandedObjectCount(value) {
    const memo = new Map();
    function size(node, stack) {
        if (node === null || typeof node !== 'object') return 0;
        if (stack.has(node)) return Infinity;
        const cached = memo.get(node);
        if (cached !== undefined) return cached;
        stack.add(node);
        let total = 1;
        const children = Array.isArray(node) ? node : Object.values(node);
        for (const child of children) {
            const nested = size(child, stack);
            if (!Number.isFinite(nested)) {
                stack.delete(node);
                memo.set(node, Infinity);
                return Infinity;
            }
            total += nested;
            if (total > YAML_EXPAND_OBJECT_LIMIT) {
                stack.delete(node);
                memo.set(node, total);
                return total;
            }
        }
        stack.delete(node);
        memo.set(node, total);
        return total;
    }
    return size(value, new Set());
}

function normalizeStringifyOptions(options = {}, content) {
    const {
        forceQuotes,
        lineWidth,
        noArrayIndent,
        noRefs,
        quotingType,
        sortKeys,
        ...rest
    } = options || {};
    // noRefs omitted: duplicate shared objects (JSON normalization, no anchors)
    // until the expanded graph would stall produce/preview. Callers that pass
    // noRefs still choose explicitly.
    const normalized = { ...rest };
    if (typeof noRefs === 'boolean') {
        normalized.aliasDuplicateObjects = !noRefs;
    } else {
        const expanded = expandedObjectCount(content);
        normalized.aliasDuplicateObjects =
            !Number.isFinite(expanded) || expanded > YAML_EXPAND_OBJECT_LIMIT;
    }

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
        normalizeStringifyOptions(options, content),
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
