import { getCreateItemPosition } from '@/utils/create-item-position';
import { deleteByName, findByName, insertByPosition } from '@/utils/database';
import { FILES_KEY } from '@/constants';
import {
    RequestInvalidError,
    ResourceNotFoundError,
} from '@/restful/errors';
import $ from '@/core/app';
import { normalizeAgePublicKeyConfig } from '@/utils/age';
import { normalizeEditorLanguageConfig } from '@/utils/editor-language';
import { normalizeFileConfig } from '@/utils/file-type';

function createFileItem(rawFile) {
    const file = normalizeFileConfig({
        ...rawFile,
    });
    normalizeAgePublicKeyConfig(file);
    normalizeEditorLanguageConfig(file);
    file.name = `${file.name ?? Date.now()}`;
    $.info(`正在创建文件：${file.name}`);
    const allFiles = $.read(FILES_KEY);
    if (findByName(allFiles, file.name)) {
        throw new RequestInvalidError(
            'DUPLICATE_KEY',
            rawFile.name
                ? `已存在 name 为 ${file.name} 的文件`
                : `无法同时创建相同的文件 可稍后重试`,
        );
    }
    insertByPosition(allFiles, file, getCreateItemPosition());
    $.write(allFiles, FILES_KEY);
    return file;
}

function deleteFileItem(name) {
    const allFiles = $.read(FILES_KEY) || [];
    const file = findByName(allFiles, name);
    if (!file) {
        throw new ResourceNotFoundError(
            'RESOURCE_NOT_FOUND',
            `File ${name} does not exist!`,
        );
    }
    deleteByName(allFiles, name);
    $.write(allFiles, FILES_KEY);
    return file;
}

export { createFileItem, deleteFileItem };
