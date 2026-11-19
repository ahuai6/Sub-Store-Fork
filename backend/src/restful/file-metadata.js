import { findByName } from '@/utils/database';
import { createFileItem } from '@/restful/file-items';
import { FILES_KEY } from '@/constants';
import { failed, success } from '@/restful/response';
import $ from '@/core/app';
import { ResourceNotFoundError } from '@/restful/errors';
import { formatDateTime } from '@/utils';
import { normalizeAgePublicKeyConfig } from '@/utils/age';
import { normalizeEditorLanguageConfig } from '@/utils/editor-language';
import { normalizeFileConfig } from '@/utils/file-type';

// Pure file metadata routes that do not invoke ProxyUtils or produceArtifact.
// Registered on sub-store-0 so home-screen metadata requests avoid cold-starting
// the heavier sub-store-1 bundle. sub-store-1 still registers full file routes
// for /api/file/:name, /share/file/:name, and backwards compatibility with older
// installed Surge modules.
export default function register($app) {
    $app.route('/api/wholeFile/:name').get(getWholeFile);
    $app.route('/api/files').get(getAllFiles).post(createFile).put(replaceFile);
    $app.route('/api/wholeFiles').get(getAllWholeFiles);
}

function createFile(req, res) {
    try {
        if (!$.read(FILES_KEY)) $.write([], FILES_KEY);
        const file = createFileItem(req.body);
        success(res, file, 201);
    } catch (error) {
        failed(res, error);
    }
}

function getWholeFile(req, res) {
    let { name } = req.params;
    let { raw } = req.query;
    const allFiles = $.read(FILES_KEY);
    const file = findByName(allFiles, name);
    if (file) {
        if (raw) {
            res.set('content-type', 'application/json')
                .set('access-control-expose-headers', 'content-disposition')
                .set(
                    'content-disposition',
                    `attachment; filename="${encodeURIComponent(
                        `sub-store_file_${name}_${formatDateTime(
                            new Date(),
                        )}.json`,
                    )}"`,
                )
                .send(JSON.stringify(file));
        } else {
            success(res, file);
        }
    } else {
        failed(
            res,
            new ResourceNotFoundError(
                `FILE_NOT_FOUND`,
                `File ${name} does not exist`,
                404,
            ),
        );
    }
}

function getAllFiles(req, res) {
    const allFiles = $.read(FILES_KEY) || [];
    success(
        res, // eslint-disable-next-line no-unused-vars
        allFiles.map(({ content, ...rest }) => rest),
    );
}

function getAllWholeFiles(req, res) {
    const allFiles = $.read(FILES_KEY) || [];
    success(res, allFiles);
}

function replaceFile(req, res) {
    try {
        const allFiles = req.body.map(normalizeFileConfig);
        allFiles.forEach((file) => {
            normalizeAgePublicKeyConfig(file);
            normalizeEditorLanguageConfig(file);
        });
        $.write(allFiles, FILES_KEY);
        success(res);
    } catch (error) {
        failed(res, error);
    }
}
