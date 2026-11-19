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

// Count duplicated object expansion caused by shared references (not unique
// tree size). A large unique Clash/Mihomo config stays at 0 extra copies and
// emits no YAML anchors, while a shared diamond (depth 18 was 29MB / 2.6s here)
// or a cycle aliases immediately before expanding.
const YAML_EXPAND_OBJECT_LIMIT = 65536;

function shouldAliasDuplicateObjects(value) {
    const memo = new Map();
    let extraCopies = 0;
    let overflow = false;

    function size(node, stack) {
        if (overflow) return YAML_EXPAND_OBJECT_LIMIT + 1;
        if (node === null || typeof node !== 'object') return 0;
        if (stack.has(node)) {
            overflow = true;
            return Infinity;
        }
        const cached = memo.get(node);
        if (cached !== undefined) {
            extraCopies += cached;
            if (!Number.isFinite(extraCopies) || extraCopies > YAML_EXPAND_OBJECT_LIMIT) {
                overflow = true;
            }
            return cached;
        }
        stack.add(node);
        let total = 1;
        const children = Array.isArray(node) ? node : Object.values(node);
        for (const child of children) {
            const nested = size(child, stack);
            if (overflow || !Number.isFinite(nested)) {
                overflow = true;
                stack.delete(node);
                memo.set(node, Infinity);
                return Infinity;
            }
            total = Math.min(total + nested, YAML_EXPAND_OBJECT_LIMIT + 1);
        }
        stack.delete(node);
        memo.set(node, total);
        return total;
    }

    size(value, new Set());
    return overflow;
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
    // until shared-reference expansion would stall produce/preview. Callers
    // that pass noRefs still choose explicitly.
    const normalized = { ...rest };
    if (typeof noRefs === 'boolean') {
        normalized.aliasDuplicateObjects = !noRefs;
    } else {
        normalized.aliasDuplicateObjects = shouldAliasDuplicateObjects(content);
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
