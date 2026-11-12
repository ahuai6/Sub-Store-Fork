export const SCHEMA_VERSION_KEY = 'schemaVersion';
export const SETTINGS_KEY = 'settings';
export const SUBS_KEY = 'subs';
export const COLLECTIONS_KEY = 'collections';
export const FILES_KEY = 'files';
export const MODULES_KEY = 'modules';
export const ARTIFACTS_KEY = 'artifacts';
export const RULES_KEY = 'rules';
export const TOKENS_KEY = 'tokens';
export const ARCHIVES_KEY = 'archives';
export const GIST_BACKUP_KEY = 'Auto Generated Sub-Store Backup';
export const GIST_BACKUP_FILE_NAME = 'Sub-Store';
export const GIST_DOWNLOAD_TOKEN_STRATEGIES = ['ask', 'overwrite', 'keep'];
export const ARTIFACT_REPOSITORY_KEY = 'Sub-Store Artifacts Repository';
export const RESOURCE_CACHE_KEY = '#sub-store-cached-resource';
export const HEADERS_RESOURCE_CACHE_KEY = '#sub-store-cached-headers-resource';
export const SCRIPT_RESOURCE_CACHE_KEY = '#sub-store-cached-script-resource';
// Produced subscription/collection bodies. Separate from the raw resource
// cache so a 4 MB iOS value can be evicted on its own.
export const OUTPUT_CACHE_KEY = '#sub-store-cached-output';
// Network check results shared by script operators. Separate store so the
// script-resource batching behavior stays the same.
export const CHECK_RESULT_CACHE_KEY = '#sub-store-cached-check';
export const LOGS_KEY = '#sub-store-logs';
export const DEFAULT_CACHE_TTL = 60 * 60 * 1000; // 1 hour
export const DEFAULT_HEADERS_CACHE_TTL = 60 * 1000; // 1 min
export const DEFAULT_SCRIPT_CACHE_TTL = 48 * 3600 * 1000; // 48 hours
export const DEFAULT_LOGS_MAX_COUNT = 0;
