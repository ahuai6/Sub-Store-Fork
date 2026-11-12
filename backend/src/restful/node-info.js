import producer from '@/core/proxy-utils/producers';
import { HTTP } from '@/vendor/open-api';
import { failed, success } from '@/restful/response';
import { NetworkError } from '@/restful/errors';
import { heavyRequestKey, shareResponse } from '@/utils/inflight';

export default function register($app) {
    $app.post('/api/utils/node-info', getNodeInfo);
}

async function getNodeInfo(req, res) {
    if (req.__forkHeavy !== 'node-info') {
        req.__forkHeavy = 'node-info';
        return shareResponse(
            heavyRequestKey('node-info', req),
            res,
            () => getNodeInfo(req, res),
            'node-info',
        );
    }
    const proxy = req.body;
    const lang = req.query.lang || 'zh-CN';
    let shareUrl;
    try {
        shareUrl = producer.URI.produce(proxy);
    } catch (err) {
        // do nothing
    }

    try {
        const $http = HTTP();
        const info = await $http
            .get({
                url: `http://ip-api.com/json/${encodeURIComponent(
                    `${proxy.server}`
                        .trim()
                        .replace(/^\[/, '')
                        .replace(/\]$/, ''),
                )}?lang=${lang}`,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
                },
            })
            .then((resp) => {
                const data = JSON.parse(resp.body);
                if (data.status !== 'success') {
                    throw new Error(data.message);
                }

                // remove unnecessary fields
                delete data.status;
                return data;
            });
        success(res, {
            shareUrl,
            info,
        });
    } catch (err) {
        failed(
            res,
            new NetworkError(
                'FAILED_TO_GET_NODE_INFO',
                `Failed to get node info`,
                `Reason: ${err}`,
            ),
        );
    }
}
